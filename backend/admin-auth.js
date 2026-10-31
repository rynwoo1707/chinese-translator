// Admin accounts (migration 0025): people sign in to /admin with a username and a password; command-line tools keep
// sending ADMIN_TOKEN as a Bearer token. In a browser ADMIN_TOKEN is typed only to create the first admin or to reset a
// forgotten admin password (POST /api/admin/setup); it stays the key of the saved Gemini key (runtime-config.js) and of
// the wrong-password counts (reader-auth.js failureKey). Passwords, wrong-password counts and device marks reuse the
// student machinery of reader-auth.js.
import {json,clientIp,isLoopback,logEvent,UserError} from './http.js';
import {rateLimit,tooMany} from './rate-limit.js';
import {adminModeOf} from '../frontend/translation-modes.js';
import {cookieValue,hashToken,bytesToBase64Url,equalBytes,passwordMatches,newCredential,DUMMY_CREDENTIAL,passwordProblem,secure,signedIn,lockedFor,countFailure,clearFailures,waitText,knownDevice,deviceCookie,ACCOUNT,EMAIL,NETWORK} from './reader-auth.js';

const ADMIN_COOKIE='cat_hien_admin',ADMIN_HEADER='X-Hoa-Tri-Admin',BACKGROUND_HEADER='X-Hoa-Tri-Background';
// A browser that signed in as an admin keeps a mark of it (reader-auth.js knownDevice), sent only to /api/admin/: its
// wrong passwords are counted on their own, so guesses typed anywhere else never lock the admin out of her own browser.
const ADMIN_DEVICE={cookie:'cat_hien_admin_device',path:'/api/admin/',label:'admin-device'};
// A session lasts at most 12 hours and ends after 2 hours without a request of the admin's own (unattended). last_seen_at
// is written at most every 5 minutes, so a busy console costs one write per 5 minutes, not one per request.
const SESSION_SECONDS=12*60*60,IDLE_MS=2*60*60*1000,SEEN_EVERY=5*60*1000;
const SIGNED_OUT='Phiên quản trị đã hết hạn. Hãy đăng nhập lại.',WRONG_LOGIN='Tên đăng nhập hoặc mật khẩu không đúng.';
const DISABLED='Tài khoản quản trị này đang bị khóa. Hãy liên hệ một quản trị viên khác.';
const BAD_USERNAME='Tên đăng nhập cần từ 3 đến 64 ký tự: chữ cái không dấu, chữ số, dấu chấm, gạch nối hoặc gạch dưới, bắt đầu bằng chữ cái hoặc chữ số.';
const USERNAME=/^[a-z0-9][a-z0-9._-]{2,63}$/u;
export const adminSignedOut=()=>json({error:SIGNED_OUT,code:'admin_signed_out'},401);

// A short ADMIN_TOKEN can be guessed, so it opens nothing outside this machine; setup generates 64 hex characters.
export const MIN_ADMIN_TOKEN=32;
export const adminTokenUsable=(env,url)=>String(env.ADMIN_TOKEN||'').length>=MIN_ADMIN_TOKEN||Boolean(env.ADMIN_TOKEN)&&isLoopback(url.hostname);
const enc=new TextEncoder(),digest=async value=>new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)));
// Compared as SHA-256 digests in constant time: the time never tells how much of a guess was right.
async function tokenMatches(env,url,value){
 if(!adminTokenUsable(env,url)||typeof value!=='string'||!value)return false;
 return equalBytes(await digest(value),await digest(env.ADMIN_TOKEN));
}

// Who is signed in as admin: {id,username,name,via:'session',expiresAt} or the token's {via:'token'}, else null. A
// Bearer header decides alone (command-line tools, as before). The cookie counts only on a request that also carries
// X-Hoa-Tri-Admin: 1, which only this site's own scripts can add: a public page (the reader's frame, a cover) never acts
// as admin with it, on top of SameSite=Strict and the Origin check. A database error signs nobody in.
const TOKEN_ADMIN=Object.freeze({id:null,username:null,name:'ADMIN_TOKEN',via:'token'});
const isProbe=url=>url?.pathname==='/api/admin/session'&&url.searchParams.get('probe')==='1';
// Not using the console: the study page's question on every load (?probe=1), and what the console asks by itself
// (X-Hoa-Tri-Background: 1: new requests every 5 minutes, a running job's row). Neither keeps a forgotten session alive.
const unattended=(request,url)=>isProbe(url)||request.headers.get(BACKGROUND_HEADER)==='1';
// "Bearer <token>", or the bare token as before. Another scheme, such as the Basic credentials a browser repeats for a site
// kept behind a password prompt, is not addressed to Hoa Trí and leaves the decision to the cookie.
const bearerOf=request=>{const value=request.headers.get('Authorization')||'';return value.startsWith('Bearer ')?value.slice(7):/\s/u.test(value)?'':value;};
export async function currentAdmin(request,env,url){
 const bearer=bearerOf(request);
 if(bearer)return await tokenMatches(env,url,bearer)?TOKEN_ADMIN:null;
 if(request.headers.get(ADMIN_HEADER)!=='1')return null;
 const token=cookieValue(request,ADMIN_COOKIE);if(!token)return null;
 const now=Date.now();
 try{
  const hash=await hashToken(token),row=await env.DB.prepare('SELECT a.id,a.username,a.name,s.expires_at,s.last_seen_at FROM admin_sessions s JOIN admin_users a ON a.id=s.admin_id WHERE s.token_hash=?1 AND s.expires_at>?2 AND s.last_seen_at>?3 AND a.disabled_at IS NULL').bind(hash,now,now-IDLE_MS).first();
  if(!row)return null;
  if(now-Number(row.last_seen_at)>=SEEN_EVERY&&!unattended(request,url))await env.DB.prepare('UPDATE admin_sessions SET last_seen_at=?2 WHERE token_hash=?1 AND last_seen_at<?2').bind(hash,now).run();
  return {id:row.id,username:row.username,name:row.name||'',via:'session',expiresAt:Number(row.expires_at)};
 }catch(error){logEvent('admin_session_error',{name:error?.name,message:String(error?.message||'').slice(0,200)});return null;}
}
// True only when the table answers and holds no admin yet: /admin then offers to create the first one. A database that
// cannot tell (migration 0025 not applied yet, an error) gives false, so the field is left out.
export async function adminSetupRequired(env){
 if(typeof env?.DB?.prepare!=='function')return false;
 try{return !await env.DB.prepare('SELECT 1 AS present FROM admin_users LIMIT 1').first();}
 catch(error){logEvent('admin_table_error',{name:error?.name,message:String(error?.message||'').slice(0,200)});return false;}
}

// {display,normalized}: the username as typed (NFC, trimmed) and as it is looked up (also lower case), or null when it
// breaks the rules.
export function adminUsername(value){
 if(typeof value!=='string')return null;
 const display=value.normalize('NFC').trim(),normalized=display.toLowerCase();
 return USERNAME.test(normalized)?{display:/^[\x21-\x7e]+$/u.test(display)?display:normalized,normalized}:null;
}
function adminName(value){
 const name=String(value??'').normalize('NFC').trim();
 if(name.length>100||/[\u0000-\u001f\u007f]/u.test(name))throw new UserError('Tên hiển thị tối đa 100 ký tự, trên một dòng.',400,'bad_name');
 return name;
}
// A new admin password: 12 to 128 characters, none of what a student's new password may not be (passwordProblem, with
// the username in place of the email), and never ADMIN_TOKEN itself, the server's key.
async function adminPassword(env,value,{username,name}){
 if(typeof value!=='string'||value.length<12||value.length>128)throw new UserError('Mật khẩu quản trị cần từ 12 đến 128 ký tự.',400,'password_length');
 const problem=passwordProblem(value,{email:username,name});
 if(problem)throw new UserError(problem.code==='password_like_email'?'Mật khẩu không được giống tên đăng nhập hay tên hiển thị, kể cả khi thêm số vào trước hoặc sau. Hãy chọn mật khẩu khác.':problem.error,400,problem.code);
 if(env.ADMIN_TOKEN&&equalBytes(await digest(value),await digest(env.ADMIN_TOKEN)))throw new UserError('Mật khẩu quản trị không được trùng với ADMIN_TOKEN: mã đó là khóa của máy chủ, không phải mật khẩu của một người.',400,'password_is_token');
 return value;
}
// The 429 for a lock from lockedFor, worded for the admin page: a forgotten admin password is reset with ADMIN_TOKEN,
// not with a student's reset link. A token lock refuses only wrong tokens (setup), which the message says.
function adminLocked({seconds,scope='failures'},what='password'){
 const wait=waitText(seconds);
 const message=scope==='network'?`Mạng Internet bạn đang dùng vừa có quá nhiều lần nhập sai mật khẩu quản trị (giới hạn chung cho cả mạng, không riêng bạn). Hãy đợi khoảng ${wait} rồi thử lại, hoặc dùng mạng khác như dữ liệu di động.`
  :what==='token'?`Mã ADMIN_TOKEN không đúng, và mạng Internet bạn đang dùng vừa có quá nhiều lần nhập sai mã này (giới hạn chung cho cả mạng, không riêng bạn). Hãy kiểm tra lại mã: mã đúng vẫn dùng được ngay. Muốn thử mã khác, hãy đợi khoảng ${wait} hoặc dùng mạng khác như dữ liệu di động.`
  :`Mật khẩu quản trị đã bị nhập sai quá nhiều lần. Hãy đợi khoảng ${wait} rồi thử lại. Nếu quên mật khẩu, hãy bấm “Quên mật khẩu?” và đặt lại bằng mã ADMIN_TOKEN.`;
 return tooMany(seconds,message,{scope});
}

// A session cookie (no Max-Age): the browser drops it when it closes, so an admin who leaves a shared computer without
// "Đăng xuất" does not leave the next person signed in as her. The session itself ends on the server (SESSION_SECONDS,
// IDLE_MS); clearing it sets Max-Age=0.
const adminCookie=(value,url,maxAge=null)=>`${ADMIN_COOKIE}=${value}; Path=/api/; HttpOnly; SameSite=Strict${maxAge===null?'':`; Max-Age=${maxAge}`}${secure(url)}`;
export const clearAdminCookie=url=>adminCookie('',url,0);
// A new session: the cookie (32 random bytes) for the browser and its SHA-256, the only part the database keeps.
async function newSession(url,now=Date.now()){const token=bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));return {hash:await hashToken(token),createdAt:now,expiresAt:now+SESSION_SECONDS*1000,cookie:adminCookie(token,url)};}
// A session for an admin who can still sign in, or null; sessions past their time go whenever one starts.
async function startSession(env,adminId,url){
 const session=await newSession(url),db=env.DB;
 const results=await db.batch([
  db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?1 OR last_seen_at<=?2').bind(session.createdAt,session.createdAt-IDLE_MS),
  db.prepare('INSERT INTO admin_sessions(token_hash,admin_id,created_at,last_seen_at,expires_at) SELECT ?1,id,?3,?3,?4 FROM admin_users WHERE id=?2 AND disabled_at IS NULL').bind(session.hash,adminId,session.createdAt,session.expiresAt),
  db.prepare('UPDATE admin_users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?1 AND EXISTS (SELECT 1 FROM admin_sessions WHERE token_hash=?2)').bind(adminId,session.hash)
 ]);
 return results[1]?.meta?.changes?session:null;
}
const publicAdmin=row=>({username:row.username,name:row.name||''});
// D1 times (CURRENT_TIMESTAMP: UTC, 'YYYY-MM-DD HH:MM:SS') as ISO 8601, or null.
const isoTime=value=>{if(!value)return null;const time=Date.parse(`${String(value).replace(' ','T')}Z`);return Number.isFinite(time)?new Date(time).toISOString():String(value);};
const listed=(row,admin)=>({id:row.id,username:row.username,name:row.name||'',createdAt:isoTime(row.created_at),lastLoginAt:isoTime(row.last_login_at),self:row.id===admin.id});
const jsonObject=body=>body&&typeof body==='object'&&!Array.isArray(body)?body:{};
const jsonBody=async request=>jsonObject(await request.json());
// A DELETE may come without a body: {} then.
const optionalBody=async request=>{const text=await request.text();return text.trim()?jsonObject(JSON.parse(text)):{};};
const adminRecord=(env,column,value)=>env.DB.prepare(`SELECT id,username,username_normalized,name,password_hash,password_salt,disabled_at FROM admin_users WHERE ${column}=?`).bind(value).first();

// Login: the steps of a student's (reader-auth.js) in the same order: per-minute limits, the lock, then PBKDF2, with the
// dummy credential for a username without an account, so neither the time nor the locks tell whether it has one. A
// browser this admin signed in from before is counted on its own (ADMIN_DEVICE).
async function login(request,env,url){
 const body=await jsonBody(request),typed=typeof body.username==='string'?body.username:'',password=body.password;
 if(!typed.trim()||typeof password!=='string'||!password)return json({error:'Hãy nhập tên đăng nhập và mật khẩu.',code:'credentials_required'},400);
 const user=adminUsername(typed)?.normalized||'',ip=clientIp(request);
 const limit=await rateLimit(env,[{binding:'API_LIMITER',key:`admin-login-ip:${ip}`},{binding:'AUTH_LIMITER',key:`admin-login:${user}|${ip}`}]);if(limit)return limit;
 // A name the rules never allow has no account: nothing to look up or count.
 if(!user)return json({error:WRONG_LOGIN},401);
 const record=await adminRecord(env,'username_normalized',user),device=await knownDevice(request,user,record||DUMMY_CREDENTIAL,ADMIN_DEVICE);
 const counts=record&&device?[[`admin-login-device:${user}|${device}`,ACCOUNT]]:[[`admin-login:${user}|${ip}`,ACCOUNT],[`admin-login-network:${ip}`,NETWORK],[`admin-login-user:${user}`,EMAIL]];
 const lock=await lockedFor(env,counts);if(lock)return adminLocked(lock);
 const matches=password.length<=128&&await passwordMatches(record||DUMMY_CREDENTIAL,password);
 if(!record||!matches){await countFailure(env,counts);return json({error:WRONG_LOGIN},401);}
 if(record.disabled_at)return json({error:DISABLED,code:'admin_disabled'},403);
 await clearFailures(env,[counts[0][0]]);
 const session=await startSession(env,record.id,url);if(!session)return json({error:WRONG_LOGIN},401);
 return signedIn(json({admin:publicAdmin(record)}),session.cookie,await deviceCookie(request,user,record,url,device,ADMIN_DEVICE));
}
// The cookie is cleared even when the server could not delete the session, so a shared computer never keeps it.
async function logout(request,env,url){
 const token=cookieValue(request,ADMIN_COOKIE),headers={'Set-Cookie':clearAdminCookie(url)};
 if(token)try{await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(await hashToken(token)).run();}
 catch(error){logEvent('admin_session_error',{name:error?.name,message:String(error?.message||'').slice(0,200)});return json({error:'Đã đăng xuất trên trình duyệt này, nhưng máy chủ chưa xóa được phiên; phiên sẽ tự hết hạn sau tối đa 2 giờ không dùng.',code:'logout_incomplete'},503,headers);}
 return json({ok:true},200,headers);
}
// The first admin, or a forgotten password, with ADMIN_TOKEN (the operator holds it: .dev.vars on this machine, a secret
// on Cloudflare). The right token always passes, also from a network locked for wrong ones, so a student sharing the
// school's address cannot keep the operator out. Wrong tokens are counted per network, after the per-minute limits
// (which bound guessing); once the network is locked they are refused uncounted, and a right one leaves the lock on.
async function setup(request,env,url){
 if(!env.ADMIN_TOKEN)return json({error:'Máy chủ chưa có ADMIN_TOKEN nên chưa tạo hay đặt lại được tài khoản quản trị. Hãy đặt ADMIN_TOKEN (trên máy này: chạy npm run setup; trên Cloudflare: npx wrangler secret put ADMIN_TOKEN) rồi thử lại.',code:'admin_token_missing'},503);
 if(!adminTokenUsable(env,url))return json({error:'ADMIN_TOKEN trên máy chủ ngắn hơn 32 ký tự nên chỉ dùng được ngay trên máy chủ (localhost). Hãy đặt lại bằng npx wrangler secret put ADMIN_TOKEN (nên dùng 64 ký tự hex).',code:'admin_token_too_short'},403);
 const ip=clientIp(request),limit=await rateLimit(env,[{binding:'API_LIMITER',key:`admin-setup-ip:${ip}`},{binding:'AUTH_LIMITER',key:`admin-setup:${ip}`}]);if(limit)return limit;
 const body=await jsonBody(request),typed=typeof body.token==='string'?body.token:'';
 // A pasted token often brings a space or a line break along.
 if(!await tokenMatches(env,url,typed)&&!(typed.trim()!==typed&&await tokenMatches(env,url,typed.trim()))){
  const counts=[[`admin-token:${ip}`,ACCOUNT]],lock=await lockedFor(env,counts);if(lock)return adminLocked(lock,'token');
  await countFailure(env,counts);return json({error:'Mã ADMIN_TOKEN không đúng.',code:'admin_token_wrong'},403);
 }
 const username=adminUsername(body.username);if(!username)return json({error:BAD_USERNAME,code:'bad_username'},400);
 // The first-run form says what it is (first:true): left open while the first admin was made elsewhere, it is refused,
 // never taken as a password reset of whichever admin it happens to name.
 const exists=await env.DB.prepare('SELECT 1 AS present FROM admin_users LIMIT 1').first();
 if(exists&&body.first===true)return json({error:'Tài khoản quản trị đầu tiên đã được tạo ở nơi khác. Hãy đăng nhập bằng tài khoản đó, hoặc nhờ người đã tạo thêm tài khoản cho bạn.',code:'admin_exists'},409);
 return exists?recover(request,env,url,username,body.password,ip):createFirst(request,env,url,username,body);
}
async function createFirst(request,env,url,username,body){
 const name=adminName(body.name),password=await adminPassword(env,body.password,{username:username.normalized,name});
 const id=crypto.randomUUID(),credential=await newCredential(password),session=await newSession(url),db=env.DB;
 // One statement decides: of two setups sent at once only one inserts, and only its session is stored.
 const results=await db.batch([
  db.prepare('INSERT INTO admin_users(id,username,username_normalized,name,password_hash,password_salt,password_changed_at,last_login_at) SELECT ?1,?2,?3,?4,?5,?6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM admin_users)').bind(id,username.display,username.normalized,name,credential.password_hash,credential.password_salt),
  db.prepare('INSERT INTO admin_sessions(token_hash,admin_id,created_at,last_seen_at,expires_at) SELECT ?1,id,?3,?3,?4 FROM admin_users WHERE id=?2').bind(session.hash,id,session.createdAt,session.expiresAt)
 ]);
 if(!results[0]?.meta?.changes)return json({error:'Tài khoản quản trị đầu tiên vừa được tạo ở nơi khác. Hãy tải lại trang rồi đăng nhập.',code:'admin_exists'},409);
 logEvent('admin_account',{action:'created_first'},'info');
 return signedIn(json({admin:{username:username.display,name},created:true},201),session.cookie,await deviceCookie(request,username.normalized,credential,url,null,ADMIN_DEVICE));
}
// A forgotten password: the named admin gets the new one, every session of hers ends, the wrong-password counts that could
// lock her out are cleared, and this browser is signed in as her (as a student's reset link signs the student in).
async function recover(request,env,url,username,typed,ip){
 const db=env.DB,record=await adminRecord(env,'username_normalized',username.normalized);
 if(!record)return json({error:'Không có tài khoản quản trị nào với tên đăng nhập này.',code:'admin_not_found'},404);
 if(record.disabled_at)return json({error:DISABLED,code:'admin_disabled'},403);
 const user=record.username_normalized,password=await adminPassword(env,typed,{username:user,name:record.name});
 const device=await knownDevice(request,user,record,ADMIN_DEVICE),credential=await newCredential(password),session=await newSession(url);
 const changed='EXISTS (SELECT 1 FROM admin_users WHERE id=?1 AND password_hash=?2)';
 const results=await db.batch([
  db.prepare('UPDATE admin_users SET password_hash=?2,password_salt=?3,password_changed_at=CURRENT_TIMESTAMP,last_login_at=CURRENT_TIMESTAMP WHERE id=?1 AND disabled_at IS NULL').bind(record.id,credential.password_hash,credential.password_salt),
  db.prepare(`DELETE FROM admin_sessions WHERE admin_id=?1 AND ${changed}`).bind(record.id,credential.password_hash),
  db.prepare(`INSERT INTO admin_sessions(token_hash,admin_id,created_at,last_seen_at,expires_at) SELECT ?3,?1,?4,?4,?5 WHERE ${changed}`).bind(record.id,credential.password_hash,session.hash,session.createdAt,session.expiresAt)
 ]);
 if(!results[0]?.meta?.changes)return json({error:'Tài khoản quản trị này vừa bị xóa hoặc khóa. Hãy tải lại trang.',code:'admin_not_found'},404);
 await clearFailures(env,[`admin-login-user:${user}`,`admin-login:${user}|${ip}`,`admin-password:${record.id}`,...(device?[`admin-login-device:${user}|${device}`]:[])]);
 logEvent('admin_account',{action:'recovered'},'info');
 return signedIn(json({admin:publicAdmin(record),created:false}),session.cookie,await deviceCookie(request,user,credential,url,device,ADMIN_DEVICE));
}
// The signed-in admin's own password (body.currentPassword), asked again for what outlasts the session (her new
// password, an admin added or removed), so a console left open or a cookie left in a browser is not enough to make an
// admin account of one's own. One count of wrong ones (ten lock all three) and one per-minute limit for the account.
// {record,body}, or {refused}: the answer to send. label: the field as her form names it.
async function confirmed(request,env,admin,label){
 const limit=await rateLimit(env,[{binding:'AUTH_LIMITER',key:`admin-password:${admin.id}`}]);if(limit)return {refused:limit};
 const body=await optionalBody(request),current=body.currentPassword;
 if(typeof current!=='string'||!current)return {refused:json({error:`Hãy nhập ${label.toLowerCase()}.`,code:'password_required'},400)};
 const counts=[[`admin-password:${admin.id}`,ACCOUNT]],lock=await lockedFor(env,counts);if(lock)return {refused:adminLocked(lock)};
 const record=await adminRecord(env,'id',admin.id);if(!record||record.disabled_at)return {refused:adminSignedOut()};
 if(current.length>128||!await passwordMatches(record,current)){await countFailure(env,counts);return {refused:json({error:`${label} không đúng.`,code:'wrong_password'},403)};}
 await clearFailures(env,[counts[0][0]]);
 return {record,body};
}
// A signed-in admin changes her password: the current one confirms it, every session of the account ends and this
// browser gets a new one.
async function changePassword(request,env,url,admin){
 if(admin.via!=='session')return json({error:'Đổi mật khẩu cần đăng nhập bằng tài khoản quản trị trên trang /admin.',code:'session_required'},403);
 const {record,body,refused}=await confirmed(request,env,admin,'Mật khẩu hiện tại');if(refused)return refused;
 const db=env.DB,current=body.currentPassword,user=record.username_normalized,password=await adminPassword(env,body.newPassword,{username:user,name:record.name});
 if(password===current)return json({error:'Mật khẩu mới cần khác mật khẩu hiện tại.',code:'password_unchanged'},400);
 const device=await knownDevice(request,user,record,ADMIN_DEVICE),credential=await newCredential(password),session=await newSession(url);
 // One transaction, claimed by the update: it changes only the password checked here, so of two changes sent at once one
 // goes through; the other statements run only after it (the new hash is unique).
 const changed='EXISTS (SELECT 1 FROM admin_users WHERE id=?1 AND password_hash=?2)';
 const results=await db.batch([
  db.prepare('UPDATE admin_users SET password_hash=?2,password_salt=?3,password_changed_at=CURRENT_TIMESTAMP WHERE id=?1 AND password_hash=?4 AND disabled_at IS NULL').bind(record.id,credential.password_hash,credential.password_salt,record.password_hash),
  db.prepare(`DELETE FROM admin_sessions WHERE admin_id=?1 AND ${changed}`).bind(record.id,credential.password_hash),
  db.prepare(`INSERT INTO admin_sessions(token_hash,admin_id,created_at,last_seen_at,expires_at) SELECT ?3,?1,?4,?4,?5 WHERE ${changed}`).bind(record.id,credential.password_hash,session.hash,session.createdAt,session.expiresAt)
 ]);
 if(!results[0]?.meta?.changes)return json({error:'Mật khẩu vừa được đổi ở nơi khác. Hãy tải lại trang rồi đăng nhập lại.',code:'password_changed'},409);
 logEvent('admin_account',{action:'password_changed'},'info');
 // ended: the other sessions; this browser's old one was replaced.
 return signedIn(json({ok:true,ended:Math.max(0,(results[1]?.meta?.changes||0)-1)}),session.cookie,await deviceCookie(request,user,credential,url,device,ADMIN_DEVICE));
}
async function listAdmins(env,admin){
 // In the order they were made (rowid breaks ties within a second).
 const rows=(await env.DB.prepare('SELECT id,username,name,created_at,last_login_at FROM admin_users ORDER BY created_at,rowid').all()).results;
 return json({admins:rows.map(row=>listed(row,admin))});
}
// Adding or removing an admin through a session is confirmed with the admin's own password (confirmed). A command-line
// tool's Bearer ADMIN_TOKEN is not asked: whoever holds the server's key can do all of it anyway.
const YOUR_PASSWORD='Mật khẩu của bạn';
async function addAdmin(request,env,admin){
 const limit=await rateLimit(env,[{binding:'AUTH_LIMITER',key:`admin-add:${admin.id||'token'}`}]);if(limit)return limit;
 const {body,refused}=admin.via==='session'?await confirmed(request,env,admin,YOUR_PASSWORD):{body:await jsonBody(request)};if(refused)return refused;
 const username=adminUsername(body.username);if(!username)return json({error:BAD_USERNAME,code:'bad_username'},400);
 const name=adminName(body.name),password=await adminPassword(env,body.password,{username:username.normalized,name});
 const id=crypto.randomUUID(),credential=await newCredential(password),taken=()=>json({error:'Tên đăng nhập này đã có tài khoản quản trị.',code:'username_taken'},409);
 let added;
 try{added=await env.DB.prepare('INSERT INTO admin_users(id,username,username_normalized,name,password_hash,password_salt,password_changed_at) SELECT ?1,?2,?3,?4,?5,?6,CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM admin_users WHERE username_normalized=?3)').bind(id,username.display,username.normalized,name,credential.password_hash,credential.password_salt).run();}
 // Two adds of one name sent at once: the unique index decides.
 catch(error){if(/UNIQUE/iu.test(String(error?.message||'')))return taken();throw error;}
 if(!added?.meta?.changes)return taken();
 logEvent('admin_account',{action:'added'},'info');
 return json({admin:listed(await env.DB.prepare('SELECT id,username,name,created_at,last_login_at FROM admin_users WHERE id=?').bind(id).first(),admin)},201);
}
async function removeAdmin(request,env,id,admin){
 if(admin.id&&id===admin.id)return json({error:'Bạn không thể tự xóa tài khoản đang đăng nhập. Hãy nhờ một quản trị viên khác.',code:'admin_self'},409);
 if(admin.via==='session'){const {refused}=await confirmed(request,env,admin,YOUR_PASSWORD);if(refused)return refused;}
 const db=env.DB,results=await db.batch([
  // Never the last admin who can sign in: checked in the same statement, so two admins removing each other at once
  // cannot both succeed.
  db.prepare('DELETE FROM admin_users WHERE id=?1 AND EXISTS (SELECT 1 FROM admin_users other WHERE other.id<>?1 AND other.disabled_at IS NULL)').bind(id),
  // Her sessions end with the account, also where foreign keys are off.
  db.prepare('DELETE FROM admin_sessions WHERE admin_id=?1 AND NOT EXISTS (SELECT 1 FROM admin_users WHERE id=?1)').bind(id)
 ]);
 if(results[0]?.meta?.changes){logEvent('admin_account',{action:'removed'},'info');return json({ok:true});}
 return await db.prepare('SELECT 1 AS present FROM admin_users WHERE id=?').bind(id).first()?json({error:'Không thể xóa quản trị viên cuối cùng: Hoa Trí cần ít nhất một tài khoản quản trị.',code:'admin_last'},409):json({error:'Không tìm thấy tài khoản quản trị.',code:'admin_not_found'},404);
}

// Routes (JSON, 64 KB bodies, http.js). Every POST and DELETE from another site's page is refused before routing
// (worker.js crossOrigin). admin: currentAdmin of this request.
// - POST /api/admin/login {username,password}: 200 {admin:{username,name}} and the cookie; 401 for a wrong username or
//   password (one message), 403 admin_disabled (right password only), 429 after too many wrong passwords.
// - POST /api/admin/logout: 200, the session deleted and the cookie cleared, also when it had already expired.
// - GET /api/admin/session: 200 {admin:{username,name},expiresAt,translationMode} for a session (not the Bearer token),
//   else 401 admin_signed_out; translationMode is the school's mode (ADMIN_TRANSLATION_MODE), which Xưởng dịch
//   preselects. With ?probe=1 (the study page's question on load) a signed-out browser gets 200 {admin:null}, and the
//   question does not count as admin activity, as no request with X-Hoa-Tri-Background: 1 does.
// - POST /api/admin/password {currentPassword,newPassword}: 200 {ok:true,ended} with a fresh cookie, every other session
//   ended; 403 wrong_password or session_required (Bearer), 400 for a weak or unchanged new password, 409 password_changed.
// - POST /api/admin/setup {token,username,name?,password,first?}: with ADMIN_TOKEN only (403 admin_token_wrong; 429 for a
//   wrong one once its network is locked, never for the right one). No admin yet: 201 {admin,created:true}, signed in as
//   the new admin (409 admin_exists when another setup won). Otherwise the named admin's password is reset: 200
//   {admin,created:false}, her sessions ended, her counts cleared, signed in as her; 404 admin_not_found. first:true (the
//   first-run form) is never a reset: 409 admin_exists once an admin exists.
// - GET /api/admin/admins: {admins:[{id,username,name,createdAt,lastLoginAt,self}]}. POST /api/admin/admins
//   {username,name?,password,currentPassword}: 201 {admin}, 409 username_taken. DELETE /api/admin/admins/:id
//   {currentPassword}: 200 {ok:true}, never oneself (409 admin_self) nor the last admin (409 admin_last); her sessions
//   end. currentPassword is the signed-in admin's own (400 password_required, 403 wrong_password, 429 locked, as for
//   a password change); a Bearer ADMIN_TOKEN sends none.
// Signed out, the admin-only ones answer 401 {code:'admin_signed_out'}.
const ROUTES=['/api/admin/login','/api/admin/logout','/api/admin/setup','/api/admin/session','/api/admin/password','/api/admin/admins'];
export async function adminAuthRoute(request,env,url,path,admin){
 if(!path.startsWith('/api/admin/'))return null;
 const method=request.method,one=path.match(/^\/api\/admin\/admins\/([^/]+)$/u);
 if(path==='/api/admin/login'&&method==='POST')return login(request,env,url);
 if(path==='/api/admin/logout'&&method==='POST')return logout(request,env,url);
 if(path==='/api/admin/setup'&&method==='POST')return setup(request,env,url);
 if(path==='/api/admin/session'&&method==='GET')return admin?.via==='session'?json({admin:publicAdmin(admin),expiresAt:new Date(admin.expiresAt).toISOString(),translationMode:adminModeOf(env.ADMIN_TRANSLATION_MODE)}):isProbe(url)?json({admin:null}):adminSignedOut();
 const password=path==='/api/admin/password'&&method==='POST',list=path==='/api/admin/admins'&&method==='GET',add=path==='/api/admin/admins'&&method==='POST',remove=Boolean(one)&&method==='DELETE';
 if((password||list||add||remove)&&!admin)return adminSignedOut();
 if(password)return changePassword(request,env,url,admin);
 if(list)return listAdmins(env,admin);
 if(add)return addAdmin(request,env,admin);
 if(remove)return removeAdmin(request,env,one[1],admin);
 return ROUTES.includes(path)||one?json({error:'Phương thức không được hỗ trợ.'},405):null;
}
