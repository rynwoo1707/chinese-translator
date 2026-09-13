const SESSION_COOKIE='cat_hien_session';
const STATE_COOKIE='cat_hien_oauth_state';
const RETURN_COOKIE='cat_hien_oauth_return';
const enc=new TextEncoder();

export function cookieValue(request,name){
 const raw=request.headers.get('Cookie')||'';
 for(const part of raw.split(';')){const i=part.indexOf('=');if(i>0&&part.slice(0,i).trim()===name)return decodeURIComponent(part.slice(i+1).trim());}
 return '';
}
export async function hashToken(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
const bytesToBase64=bytes=>btoa(String.fromCharCode(...bytes));
const base64ToBytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
async function passwordHash(password,salt){const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:210000},key,256));}
function equalBytes(a,b){if(a.length!==b.length)return false;let difference=0;for(let i=0;i<a.length;i++)difference|=a[i]^b[i];return difference===0;}
function normalizeEmail(value){const email=String(value||'').trim().toLowerCase();if(email.length>320||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Email không hợp lệ.');return email;}
function validatePassword(value){const password=String(value||'');if(password.length<8||password.length>128)throw new Error('Mật khẩu cần từ 8 đến 128 ký tự.');return password;}
function secure(url){return url.protocol==='https:'?'; Secure':'';}
function cookie(name,value,maxAge,url){return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(url)}`;}
function safeReturn(value){return typeof value==='string'&&/^\/[#/?a-zA-Z0-9._=&%-]*$/.test(value)&&!value.startsWith('//')?value:'/#account';}
export async function currentReader(request,env){
 const token=cookieValue(request,SESSION_COOKIE);if(!token)return null;
 const now=Date.now(),row=await env.DB.prepare('SELECT u.id,u.email,u.name,u.picture FROM reader_sessions s JOIN reader_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').bind(await hashToken(token),now).first();
 return row||null;
}
export function googleConfigured(env){return !!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET);}
async function createSession(env,userId,url){const token=crypto.randomUUID()+crypto.randomUUID(),maxAge=30*24*60*60;await env.DB.prepare('DELETE FROM reader_sessions WHERE expires_at<=?').bind(Date.now()).run();await env.DB.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await hashToken(token),userId,Date.now()+maxAge*1000).run();return cookie(SESSION_COOKIE,token,maxAge,url);}
export async function authRoute(request,env,url,path){
 if(path==='/api/me'&&request.method==='GET'){const user=await currentReader(request,env);return Response.json(user?{authenticated:true,googleConfigured:googleConfigured(env),user}:{authenticated:false,googleConfigured:googleConfigured(env)},{headers:{'Cache-Control':'no-store'}});}
 if(path==='/api/auth/register'&&request.method==='POST'){
  const origin=request.headers.get('Origin');if(origin&&origin!==url.origin)return Response.json({error:'Nguồn yêu cầu không hợp lệ.'},{status:403});
  const body=await request.json(),email=normalizeEmail(body.email),password=validatePassword(body.password),name=String(body.name||'').trim();if(!name||name.length>100)throw new Error('Tên hiển thị cần từ 1 đến 100 ký tự.');
  if(await env.DB.prepare('SELECT user_id FROM reader_credentials WHERE email_normalized=?').bind(email).first())return Response.json({error:'Email này đã có tài khoản.'},{status:409});
  const uid=crypto.randomUUID(),salt=crypto.getRandomValues(new Uint8Array(16)),hash=await passwordHash(password,salt);
  try{await env.DB.batch([env.DB.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').bind(uid,`local:${uid}`,email,name),env.DB.prepare('INSERT INTO reader_credentials(user_id,email_normalized,password_hash,password_salt) VALUES(?,?,?,?)').bind(uid,email,bytesToBase64(hash),bytesToBase64(salt))]);}catch{return Response.json({error:'Không thể tạo tài khoản. Email có thể đã được sử dụng.'},{status:409});}
  return Response.json({ok:true},{status:201,headers:{'Set-Cookie':await createSession(env,uid,url),'Cache-Control':'no-store'}});
 }
 if(path==='/api/auth/login'&&request.method==='POST'){
  const origin=request.headers.get('Origin');if(origin&&origin!==url.origin)return Response.json({error:'Nguồn yêu cầu không hợp lệ.'},{status:403});
  const body=await request.json(),email=normalizeEmail(body.email),password=validatePassword(body.password),credential=await env.DB.prepare('SELECT user_id,password_hash,password_salt FROM reader_credentials WHERE email_normalized=?').bind(email).first();
  const valid=credential&&equalBytes(await passwordHash(password,base64ToBytes(credential.password_salt)),base64ToBytes(credential.password_hash));if(!valid)return Response.json({error:'Email hoặc mật khẩu không đúng.'},{status:401});
  return Response.json({ok:true},{headers:{'Set-Cookie':await createSession(env,credential.user_id,url),'Cache-Control':'no-store'}});
 }
 if(path==='/api/auth/google/start'&&request.method==='GET'){
  if(!googleConfigured(env))return Response.json({error:'Đăng nhập Google chưa được cấu hình trên máy chủ.'},{status:503});
  const state=crypto.randomUUID()+crypto.randomUUID(),returnTo=safeReturn(url.searchParams.get('return_to'));
  const redirectUri=`${url.origin}/api/auth/google/callback`,params=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:redirectUri,response_type:'code',scope:'openid email profile',state,prompt:'select_account'});
  const headers=new Headers({Location:`https://accounts.google.com/o/oauth2/v2/auth?${params}`});headers.append('Set-Cookie',cookie(STATE_COOKIE,state,600,url));headers.append('Set-Cookie',cookie(RETURN_COOKIE,returnTo,600,url));return new Response(null,{status:302,headers});
 }
 if(path==='/api/auth/google/callback'&&request.method==='GET'){
  if(!googleConfigured(env))return Response.redirect(`${url.origin}/#library`,302);
  const expected=cookieValue(request,STATE_COOKIE),state=url.searchParams.get('state')||'',code=url.searchParams.get('code')||'';
  if(!expected||expected!==state||!code)return Response.json({error:'Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn.'},{status:400});
  const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:`${url.origin}/api/auth/google/callback`,grant_type:'authorization_code'})});
  if(!tokenResponse.ok)return Response.json({error:'Google không thể xác nhận đăng nhập.'},{status:502});
  const tokens=await tokenResponse.json(),profileResponse=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${tokens.access_token}`}});if(!profileResponse.ok)return Response.json({error:'Không thể lấy hồ sơ Google.'},{status:502});
  const p=await profileResponse.json();if(!p.sub||!p.email||p.email_verified!==true)return Response.json({error:'Tài khoản Google cần có email đã xác minh.'},{status:403});
  let user=await env.DB.prepare('SELECT id FROM reader_users WHERE google_sub=?').bind(p.sub).first();const uid=user?.id||crypto.randomUUID();
  if(user)await env.DB.prepare('UPDATE reader_users SET email=?,name=?,picture=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(String(p.email).slice(0,320),String(p.name||'').slice(0,200),String(p.picture||'').slice(0,1000),uid).run();
  else await env.DB.prepare('INSERT INTO reader_users(id,google_sub,email,name,picture) VALUES(?,?,?,?,?)').bind(uid,p.sub,String(p.email).slice(0,320),String(p.name||'').slice(0,200),String(p.picture||'').slice(0,1000)).run();
  const headers=new Headers({Location:new URL(safeReturn(cookieValue(request,RETURN_COOKIE)),url.origin).href});headers.append('Set-Cookie',await createSession(env,uid,url));headers.append('Set-Cookie',cookie(STATE_COOKIE,'',0,url));headers.append('Set-Cookie',cookie(RETURN_COOKIE,'',0,url));return new Response(null,{status:302,headers});
 }
 if(path==='/api/auth/logout'&&request.method==='POST'){
  const token=cookieValue(request,SESSION_COOKIE);if(token)await env.DB.prepare('DELETE FROM reader_sessions WHERE token_hash=?').bind(await hashToken(token)).run();return new Response(null,{status:204,headers:{'Set-Cookie':cookie(SESSION_COOKIE,'',0,url),'Cache-Control':'no-store'}});
 }
 return null;
}
