import {json,clientIp} from './http.js';
import {rateLimit,dailyMax} from './rate-limit.js';

const SESSION_COOKIE='cat_hien_session';
const STATE_COOKIE='cat_hien_oauth_state';
const RETURN_COOKIE='cat_hien_oauth_return';
// The terms of use and privacy policy a new account accepts; change it when either page changes materially.
export const TERMS_VERSION='2026-10';
const TERMS_REQUIRED='Hãy đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư để tạo tài khoản.';
const DISABLED='Tài khoản này đang bị tạm khóa. Hãy liên hệ quản trị viên.';
const RESET_INVALID='Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Hãy xin quản trị viên một liên kết mới.';
const SESSION_MAX_AGE=30*24*60*60,RESET_MS=24*60*60*1000,RESET_OPEN_MS=30*60*1000;
const enc=new TextEncoder();

export function cookieValue(request,name){
 const raw=request.headers.get('Cookie')||'';
 for(const part of raw.split(';')){const i=part.indexOf('=');if(i>0&&part.slice(0,i).trim()===name)return decodeURIComponent(part.slice(i+1).trim());}
 return '';
}
export async function hashToken(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
const bytesToBase64=bytes=>btoa(String.fromCharCode(...bytes));
const base64ToBytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const bytesToBase64Url=bytes=>bytesToBase64(bytes).replace(/\+/gu,'-').replace(/\//gu,'_').replace(/=+$/u,'');
// Deployed Workers reject PBKDF2 above 100,000 iterations (wrangler dev allows more), so new hashes use that maximum and
// record it; an unprefixed hash is from before this change and was made with 210,000 iterations.
const PBKDF2_ITERATIONS=100000,LEGACY_PBKDF2_ITERATIONS=210000;
async function passwordHash(password,salt,iterations=PBKDF2_ITERATIONS){const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations},key,256));}
const storedHash=hash=>`pbkdf2-sha256$${PBKDF2_ITERATIONS}$${bytesToBase64(hash)}`;
function parseStoredHash(value){const match=/^pbkdf2-sha256\$(\d{1,7})\$(.+)$/.exec(value);return match?{iterations:Number(match[1]),hash:base64ToBytes(match[2])}:{iterations:LEGACY_PBKDF2_ITERATIONS,hash:base64ToBytes(value)};}
function equalBytes(a,b){if(a.length!==b.length)return false;let difference=0;for(let i=0;i<a.length;i++)difference|=a[i]^b[i];return difference===0;}
async function passwordMatches(credential,password){const stored=parseStoredHash(String(credential.password_hash));return equalBytes(await passwordHash(password,base64ToBytes(credential.password_salt),stored.iterations),stored.hash);}
function normalizeEmail(value){const email=String(value||'').trim().toLowerCase();if(email.length>320||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Email không hợp lệ.');return email;}
function validatePassword(value){const password=String(value||'');if(password.length<8||password.length>128)throw new Error('Mật khẩu cần từ 8 đến 128 ký tự.');return password;}
function secure(url){return url.protocol==='https:'?'; Secure':'';}
function cookie(name,value,maxAge,url){return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(url)}`;}
export const clearSessionCookie=url=>cookie(SESSION_COOKIE,'',0,url);
function safeReturn(value){return typeof value==='string'&&/^\/[#/?a-zA-Z0-9._=&%-]*$/.test(value)&&!value.startsWith('//')?value:'/#account';}
const sameOrigin=(request,url)=>{const origin=request.headers.get('Origin');return !origin||origin===url.origin;};
const refused=()=>json({error:'Nguồn yêu cầu không hợp lệ.',code:'origin'},403);

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
// Why an account for this (verified) email may not be created, or null. hostedDomain: the Google account's hd claim.
export function registrationRefusal(env,email=null,{hostedDomain=null}={}){
 const {mode,domains}=registrationPolicy(env);
 if(mode==='open')return null;
 if(mode==='closed')return 'Hoa Trí hiện chưa mở đăng ký tài khoản mới. Hãy liên hệ quản trị viên.';
 if(!email||!inDomains(domains,String(email).toLowerCase().split('@').pop()))return `Chỉ email thuộc ${domains.join(' hoặc ')} được tạo tài khoản.`;
 if(workspaceRequired(env)&&!inDomains(domains,String(hostedDomain||'').toLowerCase()))return `Chỉ tài khoản Google do ${domains.join(' hoặc ')} quản lý được tạo tài khoản.`;
 return null;
}
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
// 'ok', 'wrong', or 'none' for an account without a password (Google sign-in only).
export async function checkPassword(env,userId,password){
 const credential=await env.DB.prepare('SELECT password_hash,password_salt FROM reader_credentials WHERE user_id=?').bind(userId).first();
 if(!credential)return 'none';
 return typeof password==='string'&&password.length>0&&password.length<=128&&await passwordMatches(credential,password)?'ok':'wrong';
}
export function googleConfigured(env){return !!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET);}
// A new session: the cookie for the browser and the hash of its token, the only part the database keeps.
async function newSession(url){const token=crypto.randomUUID()+crypto.randomUUID();return {hash:await hashToken(token),expiresAt:Date.now()+SESSION_MAX_AGE*1000,cookie:cookie(SESSION_COOKIE,token,SESSION_MAX_AGE,url)};}
async function createSession(env,userId,url){const session=await newSession(url);await env.DB.prepare('DELETE FROM reader_sessions WHERE expires_at<=?').bind(Date.now()).run();await env.DB.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(session.hash,userId,session.expiresAt).run();return session.cookie;}

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
// The account a link (by its hash) can still reset, with its lock; null for a link that is unknown, used or expired, or
// whose account is being deleted or has no password.
const resetLink=(env,tokenHash)=>env.DB.prepare('SELECT r.user_id,u.disabled_at FROM reader_password_resets r JOIN reader_users u ON u.id=r.user_id JOIN reader_credentials c ON c.user_id=r.user_id WHERE r.token_hash=? AND r.used_at IS NULL AND r.expires_at>? AND u.deleting_at IS NULL').bind(tokenHash,Date.now()).first();
const resetRefused=link=>link?.disabled_at?json({error:DISABLED,code:'account_disabled'},403):json({error:RESET_INVALID,code:'reset_link_invalid'},400);
export async function authRoute(request,env,url,path){
 if(path==='/api/me'&&request.method==='GET'){
  const user=await currentReader(request,env),{mode,domains}=registrationPolicy(env),shared={googleConfigured:googleConfigured(env),registration:{mode,domains},termsVersion:TERMS_VERSION};
  return json(user?{authenticated:true,...shared,user}:{authenticated:false,...shared});
 }
 if(path==='/api/auth/register'&&request.method==='POST'){
  if(!sameOrigin(request,url))return refused();
  const policy=registrationPolicy(env);
  if(policy.mode==='closed')return json({error:registrationRefusal(env),code:'registration_closed'},403);
  // Anyone can type a school address; only Google proves the mailbox is theirs (see registrationPolicy).
  if(policy.mode==='domain'){const list=policy.domains.join(' hoặc ');return json({error:googleConfigured(env)?`Tài khoản mới chỉ được tạo bằng nút “Tiếp tục bằng Google”, với email thuộc ${list}.`:`Tài khoản mới chỉ được tạo bằng Google, với email thuộc ${list}, nhưng đăng nhập Google chưa được cấu hình. Hãy liên hệ quản trị viên.`,code:'registration_google_only'},403);}
  const body=await request.json(),email=normalizeEmail(body.email),password=validatePassword(body.password),name=String(body.name||'').trim();if(!name||name.length>100)throw new Error('Tên hiển thị cần từ 1 đến 100 ký tự.');
  if(body.acceptTerms!==true)return json({error:TERMS_REQUIRED,code:'terms_required'},400);
  const ip=clientIp(request),fast=await rateLimit(env,[{binding:'AUTH_LIMITER',key:`register:${ip}`}]);if(fast)return fast;
  if(await env.DB.prepare('SELECT user_id FROM reader_credentials WHERE email_normalized=?').bind(email).first())return json({error:'Email này đã có tài khoản.'},409);
  // Counted only for an account about to be created, so typing mistakes never use up a school's shared address.
  const max=dailyMax(env,'DAILY_REGISTRATIONS_PER_IP',30),daily=await rateLimit(env,[{daily:`register:${ip}`,max,label:'tạo tài khoản'}]);if(daily)return daily;
  const uid=crypto.randomUUID(),salt=crypto.getRandomValues(new Uint8Array(16)),hash=await passwordHash(password,salt);
  try{await env.DB.batch([env.DB.prepare('INSERT INTO reader_users(id,google_sub,email,name,terms_version,terms_accepted_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)').bind(uid,`local:${uid}`,email,name,TERMS_VERSION),env.DB.prepare('INSERT INTO reader_credentials(user_id,email_normalized,password_hash,password_salt) VALUES(?,?,?,?)').bind(uid,email,storedHash(hash),bytesToBase64(salt))]);}catch{return json({error:'Không thể tạo tài khoản. Email có thể đã được sử dụng.'},409);}
  return json({ok:true},201,{'Set-Cookie':await createSession(env,uid,url)});
 }
 if(path==='/api/auth/login'&&request.method==='POST'){
  if(!sameOrigin(request,url))return refused();
  const body=await request.json(),email=normalizeEmail(body.email),password=validatePassword(body.password);
  // Checked before PBKDF2, in this order: per network, a loose cap for a whole school; per email and network, strict,
  // against guessing one account's password; per email, loose, against guesses spread over many networks. A strict
  // limit per email alone would let anyone lock a student out by guessing wrong on purpose.
  const ip=clientIp(request),limit=await rateLimit(env,[{binding:'API_LIMITER',key:`login-ip:${ip}`},{binding:'AUTH_LIMITER',key:`login:${email}|${ip}`},{binding:'API_LIMITER',key:`login-email:${email}`}]);if(limit)return limit;
  const credential=await env.DB.prepare('SELECT c.user_id,c.password_hash,c.password_salt,u.disabled_at FROM reader_credentials c JOIN reader_users u ON u.id=c.user_id WHERE c.email_normalized=?').bind(email).first();
  if(!credential||!await passwordMatches(credential,password))return json({error:'Email hoặc mật khẩu không đúng.'},401);
  if(credential.disabled_at)return json({error:DISABLED,code:'account_disabled'},403);
  return json({ok:true},200,{'Set-Cookie':await createSession(env,credential.user_id,url)});
 }
 // Opening a link trades its token for a fresh one, good for 30 minutes at most (never past the link's own expiry): the
 // address with the first token stays in the browser's history (Ctrl+H, address suggestions), which on a school's shared
 // computer would let the next person use it. The page keeps the fresh token in memory only.
 if(path==='/api/auth/password-reset/open'&&request.method==='POST'){
  if(!sameOrigin(request,url))return refused();
  const body=await request.json(),token=body?.token;
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/u.test(token))return resetRefused(null);
  const tokenHash=await hashToken(token),ip=clientIp(request),limit=await rateLimit(env,[{binding:'API_LIMITER',key:`password-reset-ip:${ip}`},{binding:'AUTH_LIMITER',key:`password-reset:${tokenHash}|${ip}`}]);if(limit)return limit;
  const link=await resetLink(env,tokenHash);if(!link||link.disabled_at)return resetRefused(link);
  const fresh=bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))),now=Date.now();
  // Only one of two opens sent at once finds the old hash still there.
  const changed=await env.DB.prepare('UPDATE reader_password_resets SET token_hash=?1,expires_at=MIN(expires_at,?2) WHERE token_hash=?3 AND used_at IS NULL AND expires_at>?4').bind(await hashToken(fresh),now+RESET_OPEN_MS,tokenHash,now).run();
  if(!changed?.meta?.changes)return resetRefused(null);
  return json({token:fresh});
 }
 if(path==='/api/auth/password-reset'&&request.method==='POST'){
  if(!sameOrigin(request,url))return refused();
  const body=await request.json(),token=body?.token;
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/u.test(token))return resetRefused(null);
  // Checked before the link is looked up, as at login: per network, the loose cap a whole class shares (a teacher may
  // hand out several links at once); per link and network, the strict one. A link (32 random bytes) cannot be guessed.
  const tokenHash=await hashToken(token),ip=clientIp(request),limit=await rateLimit(env,[{binding:'API_LIMITER',key:`password-reset-ip:${ip}`},{binding:'AUTH_LIMITER',key:`password-reset:${tokenHash}|${ip}`}]);if(limit)return limit;
  // As at login, only someone holding a valid link learns that its account is locked, and nothing changes.
  const link=await resetLink(env,tokenHash);if(!link||link.disabled_at)return resetRefused(link);
  const password=validatePassword(body.password),salt=crypto.getRandomValues(new Uint8Array(16)),hash=await passwordHash(password,salt),session=await newSession(url),db=env.DB,now=Date.now();
  // One transaction. The new session is the claim: it is inserted only while the link is unused and unexpired and its
  // account open, and every other statement waits for it, so a link sent twice at once changes the password once.
  const claimed='EXISTS (SELECT 1 FROM reader_sessions WHERE token_hash=?1)';
  const results=await db.batch([
   db.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) SELECT ?1,r.user_id,?2 FROM reader_password_resets r JOIN reader_users u ON u.id=r.user_id JOIN reader_credentials c ON c.user_id=r.user_id WHERE r.token_hash=?3 AND r.used_at IS NULL AND r.expires_at>?4 AND u.disabled_at IS NULL AND u.deleting_at IS NULL').bind(session.hash,session.expiresAt,tokenHash,now),
   db.prepare(`UPDATE reader_password_resets SET used_at=?2 WHERE token_hash=?3 AND ${claimed}`).bind(session.hash,now,tokenHash),
   db.prepare(`UPDATE reader_credentials SET password_hash=?2,password_salt=?3 WHERE user_id=?4 AND ${claimed}`).bind(session.hash,storedHash(hash),bytesToBase64(salt),link.user_id),
   // Every other session of the account ends: whoever knew the old password is signed out.
   db.prepare(`DELETE FROM reader_sessions WHERE user_id=?2 AND token_hash<>?1 AND ${claimed}`).bind(session.hash,link.user_id)
  ]);
  if(!results[0]?.meta?.changes)return resetRefused(await resetLink(env,tokenHash));
  return json({ok:true},200,{'Set-Cookie':session.cookie});
 }
 if(path==='/api/auth/google/start'&&request.method==='GET'){
  if(!googleConfigured(env))return json({error:'Đăng nhập Google chưa được cấu hình trên máy chủ.'},503);
  // The Google button is enabled by the terms checkbox, which adds accept_terms=1; a new account is created on return.
  if(url.searchParams.get('accept_terms')!=='1')return json({error:TERMS_REQUIRED,code:'terms_required'},400);
  const state=crypto.randomUUID()+crypto.randomUUID(),returnTo=safeReturn(url.searchParams.get('return_to'));
  const redirectUri=`${url.origin}/api/auth/google/callback`,params=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:redirectUri,response_type:'code',scope:'openid email profile',state,prompt:'select_account'});
  const headers=new Headers({Location:`https://accounts.google.com/o/oauth2/v2/auth?${params}`});headers.append('Set-Cookie',cookie(STATE_COOKIE,state,600,url));headers.append('Set-Cookie',cookie(RETURN_COOKIE,returnTo,600,url));return new Response(null,{status:302,headers});
 }
 if(path==='/api/auth/google/callback'&&request.method==='GET'){
  if(!googleConfigured(env))return Response.redirect(`${url.origin}/#library`,302);
  const expected=cookieValue(request,STATE_COOKIE),state=url.searchParams.get('state')||'',code=url.searchParams.get('code')||'';
  if(!expected||expected!==state||!code)return json({error:'Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn.'},400);
  const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:`${url.origin}/api/auth/google/callback`,grant_type:'authorization_code'})});
  if(!tokenResponse.ok)return json({error:'Google không thể xác nhận đăng nhập.'},502);
  const tokens=await tokenResponse.json(),profileResponse=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${tokens.access_token}`}});if(!profileResponse.ok)return json({error:'Không thể lấy hồ sơ Google.'},502);
  const p=await profileResponse.json();if(!p.sub||!p.email||p.email_verified!==true)return json({error:'Tài khoản Google cần có email đã xác minh.'},403);
  // Checked whole, never cut: a shortened address could end in an allowed domain the real one does not have.
  const email=String(p.email);if(email.length>320)return json({error:'Email của tài khoản Google không hợp lệ.'},403);
  const user=await env.DB.prepare('SELECT id,disabled_at FROM reader_users WHERE google_sub=?').bind(p.sub).first(),uid=user?.id||crypto.randomUUID();
  if(user?.disabled_at)return json({error:DISABLED,code:'account_disabled'},403);
  // A valid state proves this sign-in started with the terms accepted (see google/start), for a new or a returning user.
  if(user)await env.DB.prepare('UPDATE reader_users SET email=?,name=?,picture=?,terms_accepted_at=CASE WHEN terms_version IS ? THEN terms_accepted_at ELSE CURRENT_TIMESTAMP END,terms_version=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(email,String(p.name||'').slice(0,200),String(p.picture||'').slice(0,1000),TERMS_VERSION,TERMS_VERSION,uid).run();
  else{
   const refusal=registrationRefusal(env,email,{hostedDomain:typeof p.hd==='string'?p.hd:null});if(refusal)return json({error:refusal,code:'registration_closed'},403);
   await env.DB.prepare('INSERT INTO reader_users(id,google_sub,email,name,picture,terms_version,terms_accepted_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)').bind(uid,p.sub,email,String(p.name||'').slice(0,200),String(p.picture||'').slice(0,1000),TERMS_VERSION).run();
  }
  const headers=new Headers({Location:new URL(safeReturn(cookieValue(request,RETURN_COOKIE)),url.origin).href});headers.append('Set-Cookie',await createSession(env,uid,url));headers.append('Set-Cookie',cookie(STATE_COOKIE,'',0,url));headers.append('Set-Cookie',cookie(RETURN_COOKIE,'',0,url));return new Response(null,{status:302,headers});
 }
 if(path==='/api/auth/logout'&&request.method==='POST'){
  if(!sameOrigin(request,url))return refused();
  const token=cookieValue(request,SESSION_COOKIE);if(token)await env.DB.prepare('DELETE FROM reader_sessions WHERE token_hash=?').bind(await hashToken(token)).run();return new Response(null,{status:204,headers:{'Set-Cookie':clearSessionCookie(url),'Cache-Control':'no-store'}});
 }
 return null;
}
