import {json,clientIp,logEvent,UserError} from './http.js';
import {rateLimit,dailyMax,tooMany} from './rate-limit.js';
import {COMMON_PASSWORDS,COMMON_WORDS,KEYBOARD_RUNS} from './common-passwords.js';

const SESSION_COOKIE='cat_hien_session';
const STATE_COOKIE='cat_hien_oauth_state';
const RETURN_COOKIE='cat_hien_oauth_return';
const DEVICE_COOKIE='cat_hien_device';
// The terms of use and privacy policy a new account accepts; change it when either page changes materially.
export const TERMS_VERSION='2026-10';
const TERMS_REQUIRED='Hãy đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư để tạo tài khoản.';
const DISABLED='Tài khoản này đang bị tạm khóa. Hãy liên hệ quản trị viên.';
const RESET_INVALID='Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Hãy xin quản trị viên một liên kết mới.';
const SIGNED_OUT='Phiên đăng nhập đã hết. Hãy đăng nhập lại.';
const SESSION_MAX_AGE=30*24*60*60,RESET_MS=24*60*60*1000,RESET_OPEN_MS=30*60*1000,DEVICE_MAX_AGE=365*24*60*60,GOOGLE_TIMEOUT_MS=15000;
// Accounts one network (an IPv4 address, an IPv6 /64) may create a day, unless DAILY_REGISTRATIONS_PER_IP says otherwise
// (0 turns the cap off). A school reaches the internet through one address and a class has 40 to 45 students: 150 lets
// three classes sign up on the same day, and whoever comes after can still use Google sign-in, which has no such cap.
export const REGISTRATIONS_PER_NETWORK=150;
const enc=new TextEncoder();

// A cookie that is not valid percent-encoding reads as absent.
export function cookieValue(request,name){
 const raw=request.headers.get('Cookie')||'';
 for(const part of raw.split(';')){const i=part.indexOf('=');if(i>0&&part.slice(0,i).trim()===name){try{return decodeURIComponent(part.slice(i+1).trim());}catch{return '';}}}
 return '';
}
export async function hashToken(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
const bytesToBase64=bytes=>btoa(String.fromCharCode(...bytes));
const base64ToBytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
export const bytesToBase64Url=bytes=>bytesToBase64(bytes).replace(/\+/gu,'-').replace(/\//gu,'_').replace(/=+$/u,'');
// Deployed Workers reject PBKDF2 above 100,000 iterations (wrangler dev allows more), so new hashes use that maximum and
// record it; an unprefixed hash is from before this change and was made with 210,000 iterations. Admin accounts
// (admin-auth.js) store and check their passwords with these same functions.
const PBKDF2_ITERATIONS=100000,LEGACY_PBKDF2_ITERATIONS=210000;
async function passwordHash(password,salt,iterations=PBKDF2_ITERATIONS){const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations},key,256));}
const storedHash=hash=>`pbkdf2-sha256$${PBKDF2_ITERATIONS}$${bytesToBase64(hash)}`;
function parseStoredHash(value){const match=/^pbkdf2-sha256\$(\d{1,7})\$(.+)$/.exec(value);return match?{iterations:Number(match[1]),hash:base64ToBytes(match[2])}:{iterations:LEGACY_PBKDF2_ITERATIONS,hash:base64ToBytes(value)};}
export function equalBytes(a,b){if(a.length!==b.length)return false;let difference=0;for(let i=0;i<a.length;i++)difference|=a[i]^b[i];return difference===0;}
export async function passwordMatches(credential,password){const stored=parseStoredHash(String(credential.password_hash));return equalBytes(await passwordHash(password,base64ToBytes(credential.password_salt),stored.iterations),stored.hash);}
// Checked in place of a missing account, so a login answers in the same time whether or not the email has one. Fixed
// (a Worker may not make random values at startup); the login never counts a match against it.
export const DUMMY_CREDENTIAL={password_hash:storedHash(new Uint8Array(32)),password_salt:bytesToBase64(new Uint8Array(16))};
// A new stored password: the columns of reader_credentials (and of admin_users).
export async function newCredential(password){const salt=crypto.getRandomValues(new Uint8Array(16));return {password_hash:storedHash(await passwordHash(password,salt)),password_salt:bytesToBase64(salt)};}
function normalizeEmail(value){const email=String(value||'').trim().toLowerCase();if(email.length>320||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Email không hợp lệ.');return email;}
function validatePassword(value){const password=String(value||'');if(password.length<8||password.length>128)throw new Error('Mật khẩu cần từ 8 đến 128 ký tự.');return password;}

// What a new password (registration, reset link, change) must not be, after NIST SP 800-63B 5.1.1.2: the email, its
// name part or the display name, or a word of them (also with digits around them); a character or a group repeated, a
// run such as 12345678 or abcdefgh, a keyboard stretch or a date such as a birthday (also with at most two letters
// added); or one of the passwords people pick most often (common-passwords.js). Compared in lower case without
// Vietnamese marks, spaces or punctuation, and with digits read as the letters they stand for (p4ssw0rd). Login never
// checks this: a password chosen before keeps working (the login answer says it is weak). Returns null or {code,error}.
const fold=text=>String(text||'').normalize('NFKD').toLowerCase().replace(/\p{M}+/gu,'').replace(/đ/gu,'d');
const bare=text=>fold(text).replace(/@/gu,'a').replace(/\$/gu,'s').replace(/[^\p{L}\p{N}]+/gu,'');
const core=text=>text.replace(/^\d+|\d+$/gu,'');
const LEET={0:'o',1:'i',3:'e',4:'a',5:'s',7:'t'},unleet=text=>text.replace(/[013457]/gu,digit=>LEET[digit]);
const RUNS=[...KEYBOARD_RUNS,...KEYBOARD_RUNS.map(run=>[...run].reverse().join(''))];
function repeated(text){for(let size=1;size<=text.length/2;size++)if(text.slice(0,size).repeat(Math.ceil(text.length/size)).slice(0,text.length)===text)return true;return false;}
function sequential(text){if(text.length<4)return false;const step=text.charCodeAt(1)-text.charCodeAt(0);if(Math.abs(step)!==1)return false;for(let i=2;i<text.length;i++)if(text.charCodeAt(i)-text.charCodeAt(i-1)!==step)return false;return true;}
const keyboard=text=>text.length>=4&&RUNS.some(run=>run.includes(text));
// ddmmyyyy, mmddyyyy or yyyymmdd (1900 to 2099); ddmmyy, mmddyy or yymmdd.
function dateLike(text){
 const n=(from,to)=>Number(text.slice(from,to)),date=(day,month)=>month>=1&&month<=12&&day>=1&&day<=31,year=value=>value>=1900&&value<=2099;
 if(/^\d{8}$/u.test(text))return year(n(4,8))&&(date(n(0,2),n(2,4))||date(n(2,4),n(0,2)))||year(n(0,4))&&date(n(6,8),n(4,6));
 return /^\d{6}$/u.test(text)&&(date(n(0,2),n(2,4))||date(n(2,4),n(0,2))||date(n(4,6),n(2,4)));
}
const patterned=text=>text.length>=4&&(repeated(text)||sequential(text)||keyboard(text));
// The email, its name part, the display name and each word of them, without digits around the words.
function personal(email,name){
 const local=String(email||'').split('@')[0],words=`${fold(local)} ${fold(name)}`.split(/[^\p{L}\p{N}]+/u).map(word=>core(bare(word)));
 return [bare(local),bare(email),bare(name),...words].filter(value=>value.length>=3);
}
export function passwordProblem(password,{email='',name=''}={}){
 const typed=fold(password).replace(/\s+/gu,''),plain=bare(password),base=core(plain),digits=plain.replace(/\D/gu,'');
 const forms=[plain,unleet(plain)],bases=[base,unleet(base)].filter(text=>text.length>=3);
 if(personal(email,name).some(value=>forms.includes(value)||bases.includes(core(value))))return {code:'password_like_email',error:'Mật khẩu không được giống email hay tên của bạn, kể cả khi thêm số vào trước hoặc sau. Hãy chọn mật khẩu khác.'};
 if(patterned(typed)||patterned(plain)||dateLike(plain)||base!==plain&&patterned(base)||plain.length-digits.length<=2&&digits.length>=6&&(patterned(digits)||dateLike(digits)||COMMON_PASSWORDS.has(digits)))return {code:'password_pattern',error:'Mật khẩu này có quy luật quá dễ đoán: một ký tự hay một nhóm ký tự lặp lại, một dãy liên tiếp như 12345678 hay abcdefgh, một hàng phím như qwertyui, hoặc một ngày tháng như ngày sinh. Hãy chọn mật khẩu khác.'};
 if([typed,...forms].some(text=>COMMON_PASSWORDS.has(text))||bases.some(text=>COMMON_WORDS.has(text)))return {code:'password_common',error:'Mật khẩu này nằm trong số những mật khẩu phổ biến nhất nên rất dễ bị đoán. Hãy chọn mật khẩu khác, ví dụ ghép vài từ mà người khác khó đoán.'};
 return null;
}
// A new password checked for length and against passwordProblem: the password, or a 400 the browser shows as is.
function newPassword(value,context){const password=validatePassword(value),problem=passwordProblem(password,context);if(problem)throw new UserError(problem.error,400,problem.code);return password;}

export function secure(url){return url.protocol==='https:'?'; Secure':'';}
function cookie(name,value,maxAge,url){return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(url)}`;}
export const clearSessionCookie=url=>cookie(SESSION_COOKIE,'',0,url);
function safeReturn(value){return typeof value==='string'&&/^\/[#/?a-zA-Z0-9._=&%-]*$/.test(value)&&!value.startsWith('//')?value:'/#account';}
const sameOrigin=(request,url)=>{const origin=request.headers.get('Origin');return !origin||origin===url.origin;};
const refused=()=>json({error:'Nguồn yêu cầu không hợp lệ.',code:'origin'},403);
// A sign-in answer with its cookies, the session first.
export function signedIn(response,...cookies){for(const line of cookies)response.headers.append('Set-Cookie',line);return response;}
// A body that may be empty: {} then.
async function optionalBody(request){const text=await request.text();return text.trim()?JSON.parse(text):{};}

// Wrong passwords (table auth_failures, migration 0022), counted where they come from: [name,rule] pairs. A count
// drains one failure per `leak`, so it holds about `limit` failures in a burst and, past that, about one per `leak`:
// waiting never resets it at once. The failure that brings it to `limit` locks for a minute, and each further failure
// doubles the wait, up to an hour; a drained count starts from nothing, so nothing locks for good. Like the other limits
// these fail open (rate-limit.js): without the table, or on a storage error, nothing is blocked. A burst of parallel
// requests can pass the check before the first failure is counted; the per-minute bindings bound it.
const MINUTE=60*1000,DAY=24*60*MINUTE,FIRST_WAIT=MINUTE,LONGEST_WAIT=60*MINUTE;
// ACCOUNT: one email from one network, one browser the account signed in from, a signed-in account confirming its
// password. EMAIL: one email from every network. NETWORK: one network (a school shares one) for every email. Admin
// logins (admin-auth.js) count by the same rules, a username standing for the email.
export const ACCOUNT={limit:10,leak:15*MINUTE,scope:'failures'},EMAIL={limit:50,leak:10*MINUTE,scope:'failures'},NETWORK={limit:100,leak:30*1000,scope:'network'};
// What is counted (an email, an address) is kept only as an HMAC keyed by the server's ADMIN_TOKEN, which every
// deployment has (deploy.mjs): someone who reads the database or a backup can neither recover an address by trying all
// of them nor confirm an email. A new ADMIN_TOKEN only starts the counts afresh. Without one (tests) the key is fixed.
let failureSecret=null;
export async function failureKey(env,name){
 const secret=`auth-failures|${env?.ADMIN_TOKEN||''}`;let entry=failureSecret;
 if(entry?.secret!==secret)failureSecret=entry={secret,key:await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign'])};
 return [...new Uint8Array(await crypto.subtle.sign('HMAC',entry.key,enc.encode(name)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const failureError=error=>logEvent('auth_failure_error',{name:error?.name,message:String(error?.message||'').slice(0,200)});
const placeholders=count=>Array.from({length:count},(_,i)=>`?${i+1}`).join(',');
// Rows nobody failed with for a day go, as the privacy page says: whenever a count changes or is cleared, and, so that
// they go even when nobody types a password again, when a page checks who is signed in (GET /api/me) at most every
// PURGE_EVERY for each database binding of this Worker instance. A lock still running keeps its row.
const PURGE_EVERY=10*MINUTE,purgedAt=new WeakMap();
async function purgeFailures(env,now=Date.now()){
 const db=env?.DB;if(typeof db?.prepare!=='function')return;
 purgedAt.set(db,now);
 try{await db.prepare('DELETE FROM auth_failures WHERE updated_at<?1 AND locked_until<?2').bind(now-DAY,now).run();}catch(error){failureError(error);}
}
const purgeDue=env=>typeof env?.DB?.prepare==='function'&&Date.now()-(purgedAt.get(env.DB)??-Infinity)>=PURGE_EVERY;
// The longest lock among counts as {seconds,scope}, or null.
export async function lockedFor(env,counts,now=Date.now()){
 if(typeof env?.DB?.prepare!=='function'||!counts.length)return null;
 try{
  const keys=await Promise.all(counts.map(([name])=>failureKey(env,name)));
  const row=await env.DB.prepare(`SELECT key,locked_until FROM auth_failures WHERE key IN (${placeholders(keys.length)}) AND locked_until>?${keys.length+1} ORDER BY locked_until DESC LIMIT 1`).bind(...keys,now).first();
  const rule=row&&counts[keys.indexOf(row.key)]?.[1];
  return rule?{seconds:Math.max(1,Math.ceil((Number(row.locked_until)-now)/1000)),scope:rule.scope}:null;
 }catch(error){failureError(error);return null;}
}
// The failures a count still holds: one leaves it only once a whole `leak` has passed, so ten wrong passwords typed
// within the leak are ten, whatever time they take (the level itself drains continuously and would read 9.98).
const heldFailures=level=>Math.ceil(level-1e-9);
export async function countFailure(env,counts,now=Date.now()){
 if(typeof env?.DB?.prepare!=='function')return;
 try{
  for(const [name,rule] of counts){
   const key=await failureKey(env,name);
   const held=heldFailures(Number((await env.DB.prepare('INSERT INTO auth_failures(key,level,updated_at,locked_until) VALUES(?1,1,?2,0) ON CONFLICT(key) DO UPDATE SET level=MAX(0,auth_failures.level-MAX(0,?2-auth_failures.updated_at)*1.0/?3)+1,updated_at=MAX(auth_failures.updated_at,?2) RETURNING level').bind(key,now,rule.leak).first())?.level)||0);
   if(held>=rule.limit)await env.DB.prepare('UPDATE auth_failures SET locked_until=MAX(locked_until,?2) WHERE key=?1').bind(key,now+Math.min(LONGEST_WAIT,FIRST_WAIT*2**Math.min(held-rule.limit,12))).run();
  }
 }catch(error){failureError(error);}
 await purgeFailures(env,now);
}
export async function clearFailures(env,names){
 if(typeof env?.DB?.prepare!=='function'||!names.length)return;
 try{const keys=await Promise.all(names.map(name=>failureKey(env,name)));await env.DB.prepare(`DELETE FROM auth_failures WHERE key IN (${placeholders(keys.length)})`).bind(...keys).run();}
 catch(error){failureError(error);}
 await purgeFailures(env);
}
export const waitText=seconds=>seconds<3600?`${Math.max(1,Math.ceil(seconds/60))} phút`:'1 giờ';
// The 429 for a lock from lockedFor: scope 'failures' (this account) or 'network' (every account on this network).
export function failuresLocked({seconds,scope='failures'}){
 const message=scope==='network'
  ?`Mạng Internet bạn đang dùng vừa có quá nhiều lần nhập sai mật khẩu (giới hạn chung cho cả mạng, không riêng bạn). Hãy đợi khoảng ${waitText(seconds)} rồi thử lại, hoặc dùng mạng khác như dữ liệu di động.`
  :`Mật khẩu đã bị nhập sai quá nhiều lần. Hãy đợi khoảng ${waitText(seconds)} rồi thử lại. Nếu quên mật khẩu, hãy xin quản trị viên một liên kết đặt lại mật khẩu.`;
 return tooMany(seconds,message,{scope});
}

// A browser that signed in to an account with its password keeps a mark of it (DEVICE_COOKIE, sent only to /api/auth/):
// an id with an HMAC keyed by the account's stored password hash, so only this server can make one and every mark stops
// counting once the password changes. A marked browser's wrong passwords are counted on their own (ACCOUNT), so wrong
// passwords typed elsewhere (on the same school network or anywhere) never lock a student out of her usual browser.
const DEVICE_ENTRY=/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;
// Whose mark: a student's, or an admin's (admin-auth.js), which has its own cookie sent only to /api/admin/. The label is
// part of what the HMAC signs, so a mark of one kind never stands for the other.
const READER_DEVICE={cookie:DEVICE_COOKIE,path:'/api/auth/',label:'device'};
async function deviceTag(credential,email,id,label){const key=await crypto.subtle.importKey('raw',enc.encode(`${credential.password_hash}|${credential.password_salt}`),{name:'HMAC',hash:'SHA-256'},false,['sign']);return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(`${label}|${email}|${id}`))));}
const deviceEntries=(request,kind)=>cookieValue(request,kind.cookie).split('~').filter(entry=>DEVICE_ENTRY.test(entry)).slice(-5);
// The id of this browser's mark for the account, or null.
export async function knownDevice(request,email,credential,kind=READER_DEVICE){
 let found=null;
 // Every entry is checked, so the time does not tell which one matched.
 for(const entry of deviceEntries(request,kind)){const [id,tag]=entry.split('.');if(equalBytes(enc.encode(tag),enc.encode(await deviceTag(credential,email,id,kind.label)))&&!found)found=id;}
 return found;
}
// The cookie with this account's mark (a new one unless id names the one it had) and up to four marks of other accounts.
export async function deviceCookie(request,email,credential,url,id=null,kind=READER_DEVICE){
 const mark=id||bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),entries=deviceEntries(request,kind).filter(entry=>!entry.startsWith(`${mark}.`)).slice(-4);
 entries.push(`${mark}.${await deviceTag(credential,email,mark,kind.label)}`);
 return `${kind.cookie}=${entries.join('~')}; Path=${kind.path}; HttpOnly; SameSite=Strict; Max-Age=${DEVICE_MAX_AGE}${secure(url)}`;
}

// REGISTRATION_MODE: open (default), closed, or domain (only ALLOWED_EMAIL_DOMAINS, comma separated, subdomains
// included). An unknown value closes registration rather than opening it. Existing accounts always keep logging in.
// In domain mode only Google creates accounts: Google has verified the address (email_verified), while a typed
// address proves nothing. REQUIRE_GOOGLE_WORKSPACE=1 also asks that the Google account be one the school manages
// (Google's hd claim is an allowed domain), so an address someone once verified for a personal Google account stops
// opening accounts once the school closes the mailbox.
export function registrationPolicy(env){
 const value=String(env.REGISTRATION_MODE||'open').trim().toLowerCase(),mode=['open','closed','domain'].includes(value)?value:'closed';
 const domains=String(env.ALLOWED_EMAIL_DOMAINS||'').toLowerCase().split(/[\s,;]+/u).map(domain=>domain.replace(/^@/u,'')).filter(Boolean);
 return mode==='domain'&&!domains.length?{mode:'closed',domains:[]}:{mode,domains:mode==='domain'?domains:[]};
}
const inDomains=(domains,domain)=>Boolean(domain)&&domains.some(allowed=>domain===allowed||domain.endsWith('.'+allowed));
const workspaceRequired=env=>/^(?:1|true|yes|on)$/iu.test(String(env.REQUIRE_GOOGLE_WORKSPACE||'').trim());
// Why an account for this (verified) email may not be created, as {code,error}, or null. hostedDomain: the Google
// account's hd claim.
function refusalOf(env,email=null,{hostedDomain=null}={}){
 const {mode,domains}=registrationPolicy(env);
 if(mode==='open')return null;
 if(mode==='closed')return {code:'registration_closed',error:'Hoa Trí hiện chưa mở đăng ký tài khoản mới. Hãy liên hệ quản trị viên.'};
 if(!email||!inDomains(domains,String(email).toLowerCase().split('@').pop()))return {code:'registration_domain',error:`Chỉ email thuộc ${domains.join(' hoặc ')} được tạo tài khoản.`};
 if(workspaceRequired(env)&&!inDomains(domains,String(hostedDomain||'').toLowerCase()))return {code:'registration_workspace',error:`Chỉ tài khoản Google do ${domains.join(' hoặc ')} quản lý được tạo tài khoản.`};
 return null;
}
export function registrationRefusal(env,email=null,options={}){return refusalOf(env,email,options)?.error??null;}
// The per-minute limit and the daily cap on registration count a whole network: their answers say so, and point to
// Google sign-in where it is set up.
const NETWORK_TOO_FAST='Mạng Internet bạn đang dùng vừa tạo nhiều tài khoản trong một phút (giới hạn chung cho cả mạng, không riêng bạn). Hãy đợi khoảng một phút rồi thử lại.';
const emailTaken=env=>googleConfigured(env)?'Email này đã có tài khoản. Hãy đăng nhập bằng mật khẩu của tài khoản đó, hoặc bấm “Tiếp tục bằng Google” nếu tài khoản được tạo bằng Google.':'Email này đã có tài khoản.';
const networkCap=(env,max)=>`Mạng Internet bạn đang dùng đã tạo đủ ${max} tài khoản hôm nay. Đây là hạn mức chung cho cả mạng (ví dụ cả trường dùng chung một mạng), không phải của riêng bạn. ${googleConfigured(env)?'Bạn vẫn có thể dùng nút “Tiếp tục bằng Google” ngay bây giờ, hoặc tạo tài khoản sau 0:00 (giờ Việt Nam) hay từ mạng khác như dữ liệu di động.':'Hãy tạo tài khoản sau 0:00 (giờ Việt Nam), hoặc từ mạng khác như dữ liệu di động.'}`;

// An account being deleted (account.js) is refused like a locked one: its deletion has started.
export async function currentReader(request,env){
 const token=cookieValue(request,SESSION_COOKIE);if(!token)return null;
 const now=Date.now(),row=await env.DB.prepare("SELECT u.id,u.email,u.name,u.picture,CASE WHEN u.google_sub LIKE 'local:%' THEN 'local' ELSE 'google' END AS provider FROM reader_sessions s JOIN reader_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled_at IS NULL AND u.deleting_at IS NULL").bind(await hashToken(token),now).first();
 return row||null;
}
// Whether this request's session began less than ms ago: a sign-in that recent stands in for a password.
export async function signedInWithin(request,env,ms){
 const token=cookieValue(request,SESSION_COOKIE);if(!token)return false;
 return Boolean(await env.DB.prepare("SELECT 1 AS recent FROM reader_sessions WHERE token_hash=? AND created_at>=datetime('now',?)").bind(await hashToken(token),`-${Math.max(0,Math.floor(ms/1000))} seconds`).first());
}
// A password confirmed while signed in (changing it, deleting the account): {status} 'ok' (with credential and email),
// 'wrong', 'missing' (none typed), 'none' (a Google-only account has no password) or 'locked' (with lock, for
// failuresLocked). Wrong answers are counted per account as failed logins are, so a session left open on a shared
// computer cannot be used to try passwords one after another.
export async function verifyPassword(env,userId,password){
 const credential=await env.DB.prepare('SELECT email_normalized,password_hash,password_salt FROM reader_credentials WHERE user_id=?').bind(userId).first();
 if(!credential)return {status:'none'};
 if(typeof password!=='string'||!password)return {status:'missing'};
 const counts=[[`password:${userId}`,ACCOUNT]],lock=await lockedFor(env,counts);if(lock)return {status:'locked',lock};
 if(password.length>128||!await passwordMatches(credential,password)){await countFailure(env,counts);return {status:'wrong'};}
 await clearFailures(env,[counts[0][0]]);return {status:'ok',credential,email:credential.email_normalized};
}
// 'ok', 'wrong' (also when none was typed), 'none' for an account without a password, or 'locked'.
export async function checkPassword(env,userId,password){const {status}=await verifyPassword(env,userId,password);return status==='missing'?'wrong':status;}
export function googleConfigured(env){return !!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET);}
// A new session: the cookie for the browser and the hash of its token, the only part the database keeps.
async function newSession(url){const token=crypto.randomUUID()+crypto.randomUUID();return {hash:await hashToken(token),expiresAt:Date.now()+SESSION_MAX_AGE*1000,cookie:cookie(SESSION_COOKIE,token,SESSION_MAX_AGE,url)};}
async function createSession(env,userId,url){const session=await newSession(url);await env.DB.prepare('DELETE FROM reader_sessions WHERE expires_at<=?').bind(Date.now()).run();await env.DB.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(session.hash,userId,session.expiresAt).run();return session.cookie;}

// A Google sign-in that cannot finish lands on the account page with a code the page explains (#account?loi=<code>),
// never on a bare error. sau= keeps where the student was going (app.js takeAfterSignIn reads it as after a sign-in).
// The state and return cookies are spent either way.
// google_email_has_password: the Google account's (verified) email already has an account that signs in with a password.
export const GOOGLE_FAILURE_CODES=['google_cancelled','google_error','google_state','google_failed','google_unverified','google_email_invalid','google_email_has_password','account_disabled','registration_closed','registration_domain','registration_workspace','google_not_configured','terms_required','server_error'];
function afterSignIn(returnTo){if(/^\/study(?:\.html)?$/u.test(returnTo))return 'xuong-dich';return /^\/#(reader\/[A-Za-z0-9._%-]{1,200}\/\d{1,4})$/u.exec(returnTo)?.[1]||'';}
function googleFailed(url,code,returnTo){
 const after=afterSignIn(returnTo),headers=new Headers({Location:`${url.origin}/#account?loi=${code}${after?`&sau=${after}`:''}`});
 headers.append('Set-Cookie',cookie(STATE_COOKIE,'',0,url));headers.append('Set-Cookie',cookie(RETURN_COOKIE,'',0,url));
 if(code!=='google_cancelled')logEvent('google_sign_in_failed',{code});
 return new Response(null,{status:302,headers});
}

// Password reset links (migration 0020; no e-mail is sent). An admin creates one for an account with a password
// (account.js): {token,expiresAt} — the token is returned this once, only its SHA-256 is stored — or {refused}:
// 'missing', 'google' (no password to reset) or 'disabled'. A locked account gets no link: the link signs the student
// in, which a lock refuses (as login does), so the admin unlocks first; locking also removes the links it had. The
// account's older links stop working, and links past their 24 hours are cleared.
export async function createPasswordReset(env,userId){
 const db=env.DB,token=bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))),now=Date.now(),expires=now+RESET_MS;
 const results=await db.batch([
  db.prepare('DELETE FROM reader_password_resets WHERE user_id=?1 OR expires_at<=?2').bind(userId,now),
  db.prepare('INSERT INTO reader_password_resets(token_hash,user_id,expires_at) SELECT ?1,u.id,?2 FROM reader_users u JOIN reader_credentials c ON c.user_id=u.id WHERE u.id=?3 AND u.disabled_at IS NULL AND u.deleting_at IS NULL').bind(await hashToken(token),expires,userId)
 ]);
 if(results[1]?.meta?.changes)return {token,expiresAt:new Date(expires).toISOString()};
 const user=await db.prepare('SELECT u.disabled_at,u.deleting_at,c.user_id AS credential FROM reader_users u LEFT JOIN reader_credentials c ON c.user_id=u.id WHERE u.id=?').bind(userId).first();
 return {refused:!user||user.deleting_at?'missing':!user.credential?'google':'disabled'};
}
// The account a link (by its hash) can still reset, with its lock, email and name; null for a link that is unknown,
// used or expired, or whose account is being deleted or has no password.
const resetLink=(env,tokenHash)=>env.DB.prepare('SELECT r.user_id,r.expires_at,u.disabled_at,u.name,c.email_normalized FROM reader_password_resets r JOIN reader_users u ON u.id=r.user_id JOIN reader_credentials c ON c.user_id=r.user_id WHERE r.token_hash=? AND r.used_at IS NULL AND r.expires_at>? AND u.deleting_at IS NULL').bind(tokenHash,Date.now()).first();
const resetRefused=link=>link?.disabled_at?json({error:DISABLED,code:'account_disabled'},403):json({error:RESET_INVALID,code:'reset_link_invalid'},400);
// The hash of a reset link's token, or the answer refusing it. Limits are checked before the link is looked up, as at
// login: per network, the loose cap a whole class shares (a teacher may hand out several links at once); per link and
// network, the strict one. A link (32 random bytes) cannot be guessed.
async function resetTokenHash(request,env,token){
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/u.test(token))return resetRefused(null);
 const tokenHash=await hashToken(token),ip=clientIp(request);
 return await rateLimit(env,[{binding:'API_LIMITER',key:`password-reset-ip:${ip}`},{binding:'AUTH_LIMITER',key:`password-reset:${tokenHash}|${ip}`}])||tokenHash;
}
// Routes. Every POST refuses another site's Origin (403 {code:'origin'}); a 429 is {error,code:'rate_limited',retryAfter}
// with Retry-After, plus scope 'network' for a limit the whole network shares or 'failures' for wrong passwords.
// - POST /api/auth/register {name,email,password,acceptTerms:true}: 201 {ok:true}, signed in. 400 for a weak password:
//   the length message (no code), or {code:'password_common'|'password_like_email'|'password_pattern'}; 409
//   {code:'email_taken'} when an account, with a password or with Google, holds the email (one answer for both, pointing
//   to Google sign-in where it is set up); 429 scope 'network' when the network used its per-minute or daily
//   registrations.
// - POST /api/auth/login {email,password}: 200 {ok:true}, signed in, with weakPassword:<one of those codes> when the
//   password would no longer be accepted as a new one; 401 wrong; 403 account_disabled (right password only); 429 scope
//   'failures' or 'network' after too many wrong passwords (see the route).
// - POST /api/auth/logout: 204. POST /api/auth/logout-all [{keepCurrent:true}]: 200 {ok:true,ended,signedOut} — every
//   other session of the account ends (ended counts them), and its unused reset links; this one too (signedOut:true,
//   cookie cleared) unless keepCurrent. 401 {code:'signed_out'}.
// - POST /api/auth/password {currentPassword,newPassword}: 200 {ok:true,ended}, a new session for this browser and every
//   other one ended; 401 signed_out, 400 password_required, 403 wrong_password, 429 (scope failures), 409 no_password
//   (Google-only account) or password_changed (changed meanwhile), 400 for a weak new password (as at registration) or
//   password_unchanged.
// - POST /api/auth/password-reset/check {token}: 200 {ok:true,expiresAt} without using the link up; /open trades it,
//   /password-reset sets the password (see each route): 200 {ok:true}, signed in, with this browser's device mark and
//   the account's wrong-password counts cleared. Refusals: 400 reset_link_invalid, 403 account_disabled.
// - GET /api/auth/google/start and /callback: redirects only; a failure goes to /#account?loi=<GOOGLE_FAILURE_CODES>
//   (&sau=… keeps where the student was going), except a callback reached after the Google settings were removed.
export async function authRoute(request,env,url,path){
 if(path==='/api/me'&&request.method==='GET'){
  const user=await currentReader(request,env),{mode,domains}=registrationPolicy(env),shared={googleConfigured:googleConfigured(env),registration:{mode,domains},termsVersion:TERMS_VERSION};
  if(purgeDue(env))await purgeFailures(env);
  return json(user?{authenticated:true,...shared,user}:{authenticated:false,...shared});
 }
 if(path==='/api/auth/register'&&request.method==='POST'){
  if(!sameOrigin(request,url))return refused();
  const policy=registrationPolicy(env);
  if(policy.mode==='closed')return json({error:registrationRefusal(env),code:'registration_closed'},403);
  // Anyone can type a school address; only Google proves the mailbox is theirs (see registrationPolicy).
  if(policy.mode==='domain'){const list=policy.domains.join(' hoặc ');return json({error:googleConfigured(env)?`Tài khoản mới chỉ được tạo bằng nút “Tiếp tục bằng Google”, với email thuộc ${list}.`:`Tài khoản mới chỉ được tạo bằng Google, với email thuộc ${list}, nhưng đăng nhập Google chưa được cấu hình. Hãy liên hệ quản trị viên.`,code:'registration_google_only'},403);}
  const body=await request.json(),email=normalizeEmail(body.email),name=String(body.name||'').trim(),password=newPassword(body.password,{email,name});if(!name||name.length>100)throw new Error('Tên hiển thị cần từ 1 đến 100 ký tự.');
  if(body.acceptTerms!==true)return json({error:TERMS_REQUIRED,code:'terms_required'},400);
  // The per-minute limit is the loose one (a class signs up together); the daily cap below bounds what one network makes.
  const ip=clientIp(request),fast=await rateLimit(env,[{binding:'API_LIMITER',key:`register:${ip}`,message:NETWORK_TOO_FAST,scope:'network'}]);if(fast)return fast;
  // Counted for every valid form, an email that already has an account included: typing mistakes never use up a
  // school's shared network, and the answer below cannot be used to test more addresses than the cap.
  const max=dailyMax(env,'DAILY_REGISTRATIONS_PER_IP',REGISTRATIONS_PER_NETWORK),daily=await rateLimit(env,[{daily:`register:${ip}`,max,label:'tạo tài khoản',message:networkCap(env,max),scope:'network'}]);if(daily)return daily;
  // An email held by an account that signs in with Google is taken too (a second account would split the student's work).
  // Both kinds get the same answer, so it tells no more than before which way that account signs in.
  if(await env.DB.prepare("SELECT 1 AS taken FROM reader_credentials WHERE email_normalized=?1 UNION ALL SELECT 1 FROM reader_users WHERE lower(email)=?1 AND google_sub NOT LIKE 'local:%' LIMIT 1").bind(email).first())return json({error:emailTaken(env),code:'email_taken'},409);
  const uid=crypto.randomUUID(),credential=await newCredential(password);
  try{await env.DB.batch([env.DB.prepare('INSERT INTO reader_users(id,google_sub,email,name,terms_version,terms_accepted_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)').bind(uid,`local:${uid}`,email,name,TERMS_VERSION),env.DB.prepare('INSERT INTO reader_credentials(user_id,email_normalized,password_hash,password_salt) VALUES(?,?,?,?)').bind(uid,email,credential.password_hash,credential.password_salt)]);}catch{return json({error:'Không thể tạo tài khoản. Email có thể đã được sử dụng.',code:'email_taken'},409);}
  return signedIn(json({ok:true},201),await createSession(env,uid,url),await deviceCookie(request,email,credential,url));
 }
 if(path==='/api/auth/login'&&request.method==='POST'){
  if(!sameOrigin(request,url))return refused();
  const body=await request.json(),email=normalizeEmail(body.email),password=validatePassword(body.password);
  // Checked before PBKDF2, in this order: per network, a loose cap for a whole school; per email and network, strict,
  // against guessing one account's password; per email, loose, against guesses spread over many networks. A strict
  // limit per email alone would let anyone lock a student out by guessing wrong on purpose.
  const ip=clientIp(request),limit=await rateLimit(env,[{binding:'API_LIMITER',key:`login-ip:${ip}`},{binding:'AUTH_LIMITER',key:`login:${email}|${ip}`},{binding:'API_LIMITER',key:`login-email:${email}`}]);if(limit)return limit;
  const credential=await env.DB.prepare('SELECT c.user_id,c.password_hash,c.password_salt,u.name,u.disabled_at FROM reader_credentials c JOIN reader_users u ON u.id=c.user_id WHERE c.email_normalized=?').bind(email).first();
  // Those bindings count per minute and per Cloudflare location; wrong passwords are also counted in D1 with the same
  // three keys (ACCOUNT, NETWORK and EMAIL above). A browser the account signed in from before is counted on its own
  // instead (knownDevice), so nobody's wrong guesses lock the student out of her own browser. An email without an
  // account takes the same steps and the same PBKDF2, so neither the time nor the locks tell whether it has one.
  const device=await knownDevice(request,email,credential||DUMMY_CREDENTIAL);
  const counts=credential&&device?[[`login-device:${email}|${device}`,ACCOUNT]]:[[`login:${email}|${ip}`,ACCOUNT],[`login-network:${ip}`,NETWORK],[`login-email:${email}`,EMAIL]];
  const lock=await lockedFor(env,counts);if(lock)return failuresLocked(lock);
  const matches=await passwordMatches(credential||DUMMY_CREDENTIAL,password);
  if(!credential||!matches){await countFailure(env,counts);return json({error:'Email hoặc mật khẩu không đúng.'},401);}
  if(credential.disabled_at)return json({error:DISABLED,code:'account_disabled'},403);
  await clearFailures(env,[counts[0][0]]);
  const weak=passwordProblem(password,{email,name:credential.name});
  return signedIn(json(weak?{ok:true,weakPassword:weak.code}:{ok:true}),await createSession(env,credential.user_id,url),await deviceCookie(request,email,credential,url,device));
 }
 // Signing out everywhere, e.g. from a phone after leaving a session open on a school computer: every session of the
 // account ends, this one included unless keepCurrent, and so do its unused reset links.
 if(path==='/api/auth/logout-all'&&request.method==='POST'){
  if(!sameOrigin(request,url))return refused();
  const reader=await currentReader(request,env);if(!reader)return json({error:SIGNED_OUT,code:'signed_out'},401,{'Set-Cookie':clearSessionCookie(url)});
  const keep=(await optionalBody(request))?.keepCurrent===true,current=await hashToken(cookieValue(request,SESSION_COOKIE)),db=env.DB;
  const results=await db.batch([
   db.prepare(`DELETE FROM reader_sessions WHERE user_id=?1${keep?' AND token_hash<>?2':''}`).bind(...(keep?[reader.id,current]:[reader.id])),
   db.prepare('DELETE FROM reader_password_resets WHERE user_id=?').bind(reader.id)
  ]);
  const removed=results[0]?.meta?.changes||0;
  return keep?json({ok:true,ended:removed,signedOut:false}):json({ok:true,ended:Math.max(0,removed-1),signedOut:true},200,{'Set-Cookie':clearSessionCookie(url)});
 }
 // Changing the password while signed in: the current password confirms it (a session alone is not enough). Every other
 // session of the account ends, its unused reset links go, and this browser gets a new session.
 if(path==='/api/auth/password'&&request.method==='POST'){
  if(!sameOrigin(request,url))return refused();
  const reader=await currentReader(request,env);if(!reader)return json({error:'Hãy đăng nhập để đổi mật khẩu.',code:'signed_out'},401);
  const limit=await rateLimit(env,[{binding:'AUTH_LIMITER',key:`password-change:${reader.id}`}]);if(limit)return limit;
  const body=await request.json(),check=await verifyPassword(env,reader.id,body?.currentPassword);
  if(check.status==='none')return json({error:'Tài khoản này đăng nhập bằng Google nên không có mật khẩu để đổi.',code:'no_password'},409);
  if(check.status==='missing')return json({error:'Hãy nhập mật khẩu hiện tại.',code:'password_required'},400);
  if(check.status==='locked')return failuresLocked(check.lock);
  if(check.status==='wrong')return json({error:'Mật khẩu hiện tại không đúng.',code:'wrong_password'},403);
  const password=newPassword(body.newPassword,{email:check.email,name:reader.name});
  if(password===body.currentPassword)return json({error:'Mật khẩu mới cần khác mật khẩu hiện tại.',code:'password_unchanged'},400);
  const device=await knownDevice(request,check.email,check.credential),credential=await newCredential(password),session=await newSession(url),db=env.DB;
  // One transaction, claimed by the update: it changes only the password this request checked, of an account still
  // open, so of two changes sent at once only one goes through; the other statements run only after it (the new hash
  // is unique).
  const changed='EXISTS (SELECT 1 FROM reader_credentials WHERE user_id=?1 AND password_hash=?2)';
  const results=await db.batch([
   db.prepare('UPDATE reader_credentials SET password_hash=?2,password_salt=?3 WHERE user_id=?1 AND password_hash=?4 AND EXISTS (SELECT 1 FROM reader_users WHERE id=?1 AND disabled_at IS NULL AND deleting_at IS NULL)').bind(reader.id,credential.password_hash,credential.password_salt,check.credential.password_hash),
   db.prepare(`DELETE FROM reader_sessions WHERE user_id=?1 AND ${changed}`).bind(reader.id,credential.password_hash),
   db.prepare(`DELETE FROM reader_password_resets WHERE user_id=?1 AND ${changed}`).bind(reader.id,credential.password_hash),
   db.prepare(`INSERT INTO reader_sessions(token_hash,user_id,expires_at) SELECT ?3,?1,?4 WHERE ${changed}`).bind(reader.id,credential.password_hash,session.hash,session.expiresAt)
  ]);
  if(!results[0]?.meta?.changes)return await currentReader(request,env)?json({error:'Mật khẩu vừa được đổi ở nơi khác. Hãy tải lại trang rồi thử lại.',code:'password_changed'},409):json({error:SIGNED_OUT,code:'signed_out'},401);
  // ended: the other sessions; this browser's old one was replaced.
  return signedIn(json({ok:true,ended:Math.max(0,(results[1]?.meta?.changes||0)-1)}),session.cookie,await deviceCookie(request,check.email,credential,url,device));
 }
 // A page showing a reset link checks it with this, which uses nothing up: a mail scanner that runs the page's script
 // must not spend the link. The page trades it (/open) only when the student acts, e.g. clicks to continue.
 if(path==='/api/auth/password-reset/check'&&request.method==='POST'){
  if(!sameOrigin(request,url))return refused();
  const body=await request.json(),tokenHash=await resetTokenHash(request,env,body?.token);if(tokenHash instanceof Response)return tokenHash;
  const link=await resetLink(env,tokenHash);if(!link||link.disabled_at)return resetRefused(link);
  return json({ok:true,expiresAt:new Date(Number(link.expires_at)).toISOString()});
 }
 // Opening a link trades its token for a fresh one, good for 30 minutes at most (never past the link's own expiry): the
 // address with the first token stays in the browser's history (Ctrl+H, address suggestions), which on a school's shared
 // computer would let the next person use it. The page keeps the fresh token in memory only.
 if(path==='/api/auth/password-reset/open'&&request.method==='POST'){
  if(!sameOrigin(request,url))return refused();
  const body=await request.json(),tokenHash=await resetTokenHash(request,env,body?.token);if(tokenHash instanceof Response)return tokenHash;
  const link=await resetLink(env,tokenHash);if(!link||link.disabled_at)return resetRefused(link);
  const fresh=bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))),now=Date.now();
  // Only one of two opens sent at once finds the old hash still there.
  const changed=await env.DB.prepare('UPDATE reader_password_resets SET token_hash=?1,expires_at=MIN(expires_at,?2) WHERE token_hash=?3 AND used_at IS NULL AND expires_at>?4').bind(await hashToken(fresh),now+RESET_OPEN_MS,tokenHash,now).run();
  if(!changed?.meta?.changes)return resetRefused(null);
  return json({token:fresh});
 }
 if(path==='/api/auth/password-reset'&&request.method==='POST'){
  if(!sameOrigin(request,url))return refused();
  const body=await request.json(),tokenHash=await resetTokenHash(request,env,body?.token);if(tokenHash instanceof Response)return tokenHash;
  // As at login, only someone holding a valid link learns that its account is locked, and nothing changes.
  const link=await resetLink(env,tokenHash);if(!link||link.disabled_at)return resetRefused(link);
  const credential=await newCredential(newPassword(body.password,{email:link.email_normalized,name:link.name})),session=await newSession(url),db=env.DB,now=Date.now();
  // One transaction. The new session is the claim: it is inserted only while the link is unused and unexpired and its
  // account open, and every other statement waits for it, so a link sent twice at once changes the password once.
  const claimed='EXISTS (SELECT 1 FROM reader_sessions WHERE token_hash=?1)';
  const results=await db.batch([
   db.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) SELECT ?1,r.user_id,?2 FROM reader_password_resets r JOIN reader_users u ON u.id=r.user_id JOIN reader_credentials c ON c.user_id=r.user_id WHERE r.token_hash=?3 AND r.used_at IS NULL AND r.expires_at>?4 AND u.disabled_at IS NULL AND u.deleting_at IS NULL').bind(session.hash,session.expiresAt,tokenHash,now),
   db.prepare(`UPDATE reader_password_resets SET used_at=?2 WHERE token_hash=?3 AND ${claimed}`).bind(session.hash,now,tokenHash),
   db.prepare(`UPDATE reader_credentials SET password_hash=?2,password_salt=?3 WHERE user_id=?4 AND ${claimed}`).bind(session.hash,credential.password_hash,credential.password_salt,link.user_id),
   // Every other session of the account ends: whoever knew the old password is signed out.
   db.prepare(`DELETE FROM reader_sessions WHERE user_id=?2 AND token_hash<>?1 AND ${claimed}`).bind(session.hash,link.user_id)
  ]);
  if(!results[0]?.meta?.changes)return resetRefused(await resetLink(env,tokenHash));
  // A reset link is the remedy the lock's answer names: the wrong passwords counted for the account (from this network,
  // from every network, and in its signed-in checks) are cleared, and this browser gets a mark of the new password, as
  // a password change gives one, so guesses elsewhere do not lock it out again.
  await clearFailures(env,[`login:${link.email_normalized}|${clientIp(request)}`,`login-email:${link.email_normalized}`,`password:${link.user_id}`]);
  return signedIn(json({ok:true}),session.cookie,await deviceCookie(request,link.email_normalized,credential,url));
 }
 if(path==='/api/auth/google/start'&&request.method==='GET'){
  const returnTo=safeReturn(url.searchParams.get('return_to'));
  if(!googleConfigured(env))return googleFailed(url,'google_not_configured',returnTo);
  // The Google button is enabled by the terms checkbox, which adds accept_terms=1; a new account is created on return.
  if(url.searchParams.get('accept_terms')!=='1')return googleFailed(url,'terms_required',returnTo);
  const state=crypto.randomUUID()+crypto.randomUUID();
  const redirectUri=`${url.origin}/api/auth/google/callback`,params=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:redirectUri,response_type:'code',scope:'openid email profile',state,prompt:'select_account'});
  const headers=new Headers({Location:`https://accounts.google.com/o/oauth2/v2/auth?${params}`});headers.append('Set-Cookie',cookie(STATE_COOKIE,state,600,url));headers.append('Set-Cookie',cookie(RETURN_COOKIE,returnTo,600,url));return new Response(null,{status:302,headers});
 }
 if(path==='/api/auth/google/callback'&&request.method==='GET'){
  // Reached only when the server's Google settings were removed meanwhile: there is nothing to finish.
  if(!googleConfigured(env))return Response.redirect(`${url.origin}/#library`,302);
  const returnTo=safeReturn(cookieValue(request,RETURN_COOKIE)),failed=code=>googleFailed(url,code,returnTo);
  // Google's own refusal: error=access_denied when the student pressed Cancel. It signs nobody in, so needs no state.
  const refusal=url.searchParams.get('error');if(refusal)return failed(refusal==='access_denied'?'google_cancelled':'google_error');
  const expected=cookieValue(request,STATE_COOKIE),state=url.searchParams.get('state')||'',code=url.searchParams.get('code')||'';
  if(!expected||expected!==state||!code)return failed('google_state');
  let p;
  try{
   const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:`${url.origin}/api/auth/google/callback`,grant_type:'authorization_code'}),signal:AbortSignal.timeout(GOOGLE_TIMEOUT_MS)});
   if(!tokenResponse.ok){logEvent('google_sign_in_error',{step:'token',status:tokenResponse.status});return failed('google_failed');}
   const tokens=await tokenResponse.json(),profileResponse=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${tokens.access_token}`},signal:AbortSignal.timeout(GOOGLE_TIMEOUT_MS)});
   if(!profileResponse.ok){logEvent('google_sign_in_error',{step:'profile',status:profileResponse.status});return failed('google_failed');}
   p=await profileResponse.json();
  }catch(error){logEvent('google_sign_in_error',{step:'fetch',name:error?.name,message:String(error?.message||'').slice(0,200)});return failed('google_failed');}
  if(!p?.sub||!p.email||p.email_verified!==true)return failed('google_unverified');
  // Checked whole, never cut: a shortened address could end in an allowed domain the real one does not have.
  const email=String(p.email);if(email.length>320)return failed('google_email_invalid');
  let session;
  try{
   const user=await env.DB.prepare('SELECT id,disabled_at FROM reader_users WHERE google_sub=?').bind(String(p.sub)).first(),uid=user?.id||crypto.randomUUID();
   if(user?.disabled_at)return failed('account_disabled');
   // A Google account seen for the first time whose email already signs in with a password: no second, empty account
   // is made, and the two are never joined (registration never proves an email, so whoever registered the address first
   // must not gain the Google account, nor the other way round). The student signs in with the password, or asks the
   // admin. Only someone Google has shown to hold the address learns this.
   if(!user){const local=await env.DB.prepare('SELECT u.disabled_at FROM reader_credentials c JOIN reader_users u ON u.id=c.user_id WHERE c.email_normalized=?').bind(email.trim().toLowerCase()).first();if(local)return failed(local.disabled_at?'account_disabled':'google_email_has_password');}
   // A valid state proves this sign-in started with the terms accepted (see google/start), for a new or a returning user.
   if(user)await env.DB.prepare('UPDATE reader_users SET email=?,name=?,picture=?,terms_accepted_at=CASE WHEN terms_version IS ? THEN terms_accepted_at ELSE CURRENT_TIMESTAMP END,terms_version=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(email,String(p.name||'').slice(0,200),String(p.picture||'').slice(0,1000),TERMS_VERSION,TERMS_VERSION,uid).run();
   else{
    const notAllowed=refusalOf(env,email,{hostedDomain:typeof p.hd==='string'?p.hd:null});if(notAllowed)return failed(notAllowed.code);
    await env.DB.prepare('INSERT INTO reader_users(id,google_sub,email,name,picture,terms_version,terms_accepted_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)').bind(uid,String(p.sub),email,String(p.name||'').slice(0,200),String(p.picture||'').slice(0,1000),TERMS_VERSION).run();
   }
   session=await createSession(env,uid,url);
  }catch(error){logEvent('google_sign_in_error',{step:'account',name:error?.name,message:String(error?.message||'').slice(0,200)});return failed('server_error');}
  const headers=new Headers({Location:new URL(returnTo,url.origin).href});headers.append('Set-Cookie',session);headers.append('Set-Cookie',cookie(STATE_COOKIE,'',0,url));headers.append('Set-Cookie',cookie(RETURN_COOKIE,'',0,url));return new Response(null,{status:302,headers});
 }
 if(path==='/api/auth/logout'&&request.method==='POST'){
  if(!sameOrigin(request,url))return refused();
  const token=cookieValue(request,SESSION_COOKIE);if(token)await env.DB.prepare('DELETE FROM reader_sessions WHERE token_hash=?').bind(await hashToken(token)).run();return new Response(null,{status:204,headers:{'Set-Cookie':clearSessionCookie(url),'Cache-Control':'no-store'}});
 }
 return null;
}
