import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import {sqliteEnvironment,signedIn} from './test-support/sqlite-d1.mjs';
import {hashToken,failureKey} from './reader-auth.js';

// Admin accounts (admin-auth.js, migration 0025), run as the /admin page and the command-line tools call them: real SQLite
// with every migration, through worker.fetch. ADMIN_TOKEN is made at run time (64 hex characters with no pattern), so the
// repository holds nothing shaped like a secret.
const origin='https://hoa-tri.example',TOKEN=Array.from({length:32},(_,i)=>((i*37+11)%256).toString(16).padStart(2,'0')).join('');
const USERNAME='ThayMinh',NAME='Thầy Minh',PASSWORD='hoa-mai-no-som-mua-xuan',NEW_PASSWORD='bien-xanh-cat-trang-nang-vang',NOW=Date.parse('2026-10-26T01:00:00Z');
const MINUTE=60*1000,HOUR=60*MINUTE,WRONG={error:'Tên đăng nhập hoặc mật khẩu không đúng.'},SIGNED_OUT={error:'Phiên quản trị đã hết hạn. Hãy đăng nhập lại.',code:'admin_signed_out'};
// The session cookie as every sign-in sets it (setup, login, recovery, a password change): a session cookie, with neither
// Max-Age nor Expires, so the browser drops it when it closes; the server ends the session after 12 hours all the same.
const SESSION_COOKIE=/^cat_hien_admin=[A-Za-z0-9_-]{43}; Path=\/api\/; HttpOnly; SameSite=Strict; Secure$/u;
// The log lines of a test (account changes are logged, admin-auth.js) are kept rather than printed; logs(t) reads them.
const captured=new WeakMap();
function logs(t){if(!captured.has(t)){const lines=[];t.mock.method(console,'error',line=>lines.push(String(line)));captured.set(t,lines);}return captured.get(t);}
// The JSON events among them (the runtime may print a warning of its own).
const events=lines=>lines.flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
const environment=(t,vars={})=>{logs(t);return sqliteEnvironment(t,{vars:{ADMIN_TOKEN:TOKEN,...vars}});};
// One browser: it keeps the cookies the server sets (a cleared one is dropped) and sends them back, with
// X-Hoa-Tri-Admin: 1 as the admin console sends it (admin:false leaves the header out, as a public page does).
function browser(env,{ip='198.51.100.1',base=origin}={}){
 const jar=new Map();
 const send=async(path,{method='GET',body,headers={},admin=true,from=ip}={})=>{
  const cookies=[...jar].map(([name,value])=>`${name}=${value}`).join('; ');
  const init={method,headers:{Origin:base,'CF-Connecting-IP':from,...(admin?{'X-Hoa-Tri-Admin':'1'}:{}),...(cookies?{Cookie:cookies}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers}};
  if(body!==undefined)init.body=typeof body==='string'?body:JSON.stringify(body);
  const response=await worker.fetch(new Request(base+path,init),env,{}),text=await response.text();
  for(const line of response.headers.getSetCookie()){const pair=line.split(';')[0],i=pair.indexOf('=');if(/Max-Age=0(?:;|$)/u.test(line))jar.delete(pair.slice(0,i));else jar.set(pair.slice(0,i),pair.slice(i+1));}
  let json=null;try{json=JSON.parse(text);}catch{}
  return {status:response.status,headers:response.headers,json,text,cookies:response.headers.getSetCookie()};
 };
 return {jar,send,
  setup:(body={},options={})=>send('/api/admin/setup',{method:'POST',body:{token:TOKEN,username:USERNAME,name:NAME,password:PASSWORD,...body},...options}),
  login:(username,password,options={})=>send('/api/admin/login',{method:'POST',body:{username,password},...options}),
  session:async()=>(await send('/api/admin/session')).status,
  status:async(options={})=>(await send('/api/status',options)).json};
}
const clock=t=>{t.mock.timers.enable({apis:['Date'],now:NOW});return ms=>t.mock.timers.tick(ms);};
const rows=(sqlite,sql,...args)=>sqlite.prepare(sql).all(...args).map(row=>({...row}));
const failureLevel=async(sqlite,name)=>sqlite.prepare('SELECT level FROM auth_failures WHERE key=?').get(await failureKey({ADMIN_TOKEN:TOKEN},name))?.level??0;
// The first admin, made on /admin with ADMIN_TOKEN, and her browser (signed in, with its device mark).
async function firstAdmin(env,options){const client=browser(env,options),created=await client.setup();assert.equal(created.status,201,created.text);return client;}

test('Migration 0025 adds the admin tables and the job columns; a session goes with its admin',async t=>{
 const {sqlite}=environment(t);
 assert.deepEqual(rows(sqlite,'PRAGMA table_info(admin_users)').map(({name,notnull,pk})=>[name,notnull,pk]),[['id',0,1],['username',1,0],['username_normalized',1,0],['name',1,0],['password_hash',1,0],['password_salt',1,0],['created_at',1,0],['password_changed_at',0,0],['last_login_at',0,0],['disabled_at',0,0]]);
 assert.deepEqual(rows(sqlite,'PRAGMA table_info(admin_sessions)').map(({name,type})=>[name,type]),[['token_hash','TEXT'],['admin_id','TEXT'],['created_at','INTEGER'],['last_seen_at','INTEGER'],['expires_at','INTEGER']]);
 assert.deepEqual(rows(sqlite,'PRAGMA foreign_key_list(admin_sessions)').map(({table,from,to,on_delete})=>({table,from,to,on_delete})),[{table:'admin_users',from:'admin_id',to:'id',on_delete:'CASCADE'}]);
 const indexes=rows(sqlite,'PRAGMA index_list(admin_sessions)').map(index=>index.name);for(const name of ['idx_admin_sessions_admin','idx_admin_sessions_expiry'])assert.ok(indexes.includes(name),name);
 assert.ok(rows(sqlite,'PRAGMA index_list(admin_users)').some(index=>index.unique===1&&rows(sqlite,`PRAGMA index_info(${JSON.stringify(index.name)})`).some(column=>column.name==='username_normalized')),'one account per normalized username');
 const jobs=Object.fromEntries(rows(sqlite,'PRAGMA table_info(jobs)').map(column=>[column.name,column]));
 assert.equal(jobs.mode.type,'TEXT');assert.equal(jobs.mode.notnull,0);assert.equal(jobs.thinking_tokens.type,'INTEGER');assert.equal(jobs.thinking_tokens.dflt_value,'0');
 sqlite.prepare("INSERT INTO admin_users(id,username,username_normalized,password_hash,password_salt) VALUES('a1','x','x','h','s')").run();
 sqlite.prepare("INSERT INTO admin_sessions(token_hash,admin_id,created_at,last_seen_at,expires_at) VALUES('t1','a1',1,1,2)").run();
 sqlite.prepare("DELETE FROM admin_users WHERE id='a1'").run();assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get().n,0);
});

test('A fresh install asks for the first admin; ADMIN_TOKEN creates it once and signs it in with a strict, HttpOnly cookie',async t=>{
 const {sqlite,env}=environment(t),client=browser(env),count=()=>sqlite.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n;
 assert.deepEqual(await client.status(),{authenticated:false,adminSetupRequired:true});
 for(const token of ['',TOKEN.slice(1),`${TOKEN}0`,TOKEN.toUpperCase(),42]){const refused=await client.setup({token});assert.equal(refused.status,403,String(token));assert.deepEqual(refused.json,{error:'Mã ADMIN_TOKEN không đúng.',code:'admin_token_wrong'});}
 // Rules for the account: the username's characters, the password's length and the student rules, never the token.
 for(const [body,code] of [[{username:'ab'},'bad_username'],[{username:'thầy minh'},'bad_username'],[{username:'.minh'},'bad_username'],[{password:'ngan-qua'},'password_length'],[{password:'x'.repeat(129)},'password_length'],[{password:'P@ssw0rd2024'},'password_common'],[{password:'abababababab'},'password_pattern'],[{password:'ThayMinh2026'},'password_like_email'],[{password:TOKEN},'password_is_token'],[{name:'Dòng một\nDòng hai'},'bad_name']]){
  const refused=await client.setup(body);assert.equal(refused.status,400,code);assert.equal(refused.json.code,code);assert.equal(refused.cookies.length,0);
 }
 assert.equal(count(),0,'nothing was created');
 // A token pasted with a line break still works.
 const created=await client.setup({token:` ${TOKEN}\n`});
 assert.equal(created.status,201);assert.deepEqual(created.json,{admin:{username:USERNAME,name:NAME},created:true});
 const [session,device,...more]=created.cookies;assert.deepEqual(more,[]);
 assert.match(session,SESSION_COOKIE);
 assert.match(device,/^cat_hien_admin_device=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}; Path=\/api\/admin\/; HttpOnly; SameSite=Strict; Max-Age=31536000; Secure$/u);
 // Only the SHA-256 of the cookie is kept; the password as PBKDF2 like a student's.
 const value=session.split(';')[0].split('=')[1],[row]=rows(sqlite,'SELECT * FROM admin_users'),[stored]=rows(sqlite,'SELECT * FROM admin_sessions');
 assert.deepEqual([row.username,row.username_normalized,row.name],[USERNAME,'thayminh',NAME]);assert.match(row.password_hash,/^pbkdf2-sha256\$100000\$[A-Za-z0-9+/]{43}=$/u);assert.ok(row.last_login_at&&row.password_changed_at);
 assert.equal(stored.token_hash,await hashToken(value));assert.equal(stored.admin_id,row.id);assert.equal(stored.expires_at-stored.created_at,12*HOUR);
 assert.ok(!JSON.stringify(rows(sqlite,'SELECT * FROM admin_sessions')).includes(value));
 const status=await client.status();
 assert.deepEqual([status.authenticated,status.admin,status.via,status.translationMode],[true,{username:USERNAME,name:NAME},'session','premium']);
 const session2=await client.send('/api/admin/session');assert.deepEqual(session2.json,{admin:{username:USERNAME,name:NAME},expiresAt:new Date(stored.expires_at).toISOString(),translationMode:'premium'});
 // The school's mode, which Xưởng dịch preselects, follows ADMIN_TRANSLATION_MODE; a value naming no mode is Kỹ nhất.
 for(const [value,mode] of [['quality','quality'],[' economy ','economy'],['turbo','premium']]){env.ADMIN_TRANSLATION_MODE=value;assert.equal((await client.send('/api/admin/session')).json.translationMode,mode,value);assert.equal((await client.status()).translationMode,mode,value);}
 delete env.ADMIN_TRANSLATION_MODE;
 // Setup is over: another browser sees the login form, and the same form now resets a password instead.
 assert.deepEqual(await browser(env).status(),{authenticated:false});
 assert.equal(count(),1);
 // A first-run form (first:true) left open while the first admin was made is refused, whatever username it names: it
 // never resets that admin's password.
 for(const username of [USERNAME,'lan.nguyen']){const stale=await browser(env,{ip:'198.51.100.3'}).setup({username,password:NEW_PASSWORD,first:true});assert.equal(stale.status,409,username);assert.equal(stale.json.code,'admin_exists',username);assert.equal(stale.cookies.length,0,username);}
 assert.equal(rows(sqlite,'SELECT password_hash FROM admin_users')[0].password_hash,row.password_hash,'the first admin keeps the password');assert.equal(count(),1);
 // On this machine over http the cookie carries no Secure, and a short local token is enough (as with wrangler dev).
 const local=environment(t,{ADMIN_TOKEN:'token-cuc-bo-ngan'}),here=browser(local.env,{base:'http://127.0.0.1:8787'});
 const made=await here.setup({token:'token-cuc-bo-ngan'});assert.equal(made.status,201);assert.match(made.cookies[0],/^cat_hien_admin=[A-Za-z0-9_-]{43}; Path=\/api\/; HttpOnly; SameSite=Strict$/u);
 // A server whose token is too short for a public address, or has none, refuses before any count or check.
 const short=environment(t,{ADMIN_TOKEN:'token-cuc-bo-ngan'}),far=await browser(short.env).setup({token:'token-cuc-bo-ngan'});
 assert.equal(far.status,403);assert.equal(far.json.code,'admin_token_too_short');assert.deepEqual(await browser(short.env).status(),{authenticated:false,adminSetupRequired:true,adminTokenTooShort:true});
 const none=environment(t,{ADMIN_TOKEN:''}),missing=await browser(none.env).setup();assert.equal(missing.status,503);assert.equal(missing.json.code,'admin_token_missing');
 // A database without migration 0025 cannot say: no setup prompt, and the console stays closed.
 const old=sqliteEnvironment(t,{before:'0025',vars:{ADMIN_TOKEN:TOKEN}}),lines=logs(t);
 assert.deepEqual(await browser(old.env).status(),{authenticated:false});assert.ok(events(lines).some(entry=>entry.event==='admin_table_error'));
});

test('Two setups sent at once make one admin; the other is told to sign in',async t=>{
 const {sqlite,env}=environment(t),waiting=[],{batch}=env.DB;
 // Each request has checked that no admin exists and hashed its password before either one writes.
 env.DB.batch=async statements=>{if(statements[0].statement.sourceSQL.startsWith('INSERT INTO admin_users'))await new Promise(done=>{waiting.push(done);if(waiting.length===2)for(const release of waiting)release();});return batch.call(env.DB,statements);};
 const answers=await Promise.all([browser(env).setup({username:'minh'}),browser(env,{ip:'198.51.100.2'}).setup({username:'lan.nguyen',password:NEW_PASSWORD})]);
 assert.deepEqual(answers.map(answer=>answer.status).sort(),[201,409]);
 const loser=answers.find(answer=>answer.status===409);assert.equal(loser.json.code,'admin_exists');assert.equal(loser.cookies.length,0);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n,1);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get().n,1,'only the winner is signed in');
});

test('Login: a wrong password and an unknown username get one answer and the same password hashing; the right one signs in',async t=>{
 const {sqlite,env}=environment(t);await firstAdmin(env);
 const deriveBits=crypto.subtle.deriveBits.bind(crypto.subtle),iterations=[];
 t.mock.method(crypto.subtle,'deriveBits',async(algorithm,key,length)=>{iterations.push(algorithm.iterations);return deriveBits(algorithm,key,length);});
 const attempt=async(username,password)=>{iterations.length=0;const answer=await browser(env,{ip:'203.0.113.9'}).login(username,password);return {status:answer.status,json:answer.json,cookies:answer.cookies.length,hashed:[...iterations]};};
 const wrong=await attempt('thayminh','sai-mat-khau-roi'),unknown=await attempt('khong-ai-ca','sai-mat-khau-roi');
 assert.deepEqual(wrong,{status:401,json:WRONG,cookies:0,hashed:[100000]});assert.deepEqual(unknown,wrong,'nothing tells whether the username has an account');
 assert.deepEqual(await attempt('a b',PASSWORD),{status:401,json:WRONG,cookies:0,hashed:[]},'a name the rules never allow is not looked up');
 for(const body of [{username:'thayminh'},{password:PASSWORD},{username:' ',password:PASSWORD},{username:'thayminh',password:42}]){const refused=await browser(env).send('/api/admin/login',{method:'POST',body});assert.equal(refused.status,400);assert.equal(refused.json.code,'credentials_required');}
 // The username is matched in any case and with spaces around it; the answer names the account as it was created.
 const client=browser(env),signed=await client.login('  THAYMINH ',PASSWORD);
 assert.equal(signed.status,200);assert.deepEqual(signed.json,{admin:{username:USERNAME,name:NAME}});assert.equal(signed.cookies.length,2);assert.match(signed.cookies[0],SESSION_COOKIE);
 assert.equal((await client.send('/api/jobs')).status,200,'the console opens');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get().n,2,'the setup browser keeps its own session');
 // Limits are asked before anything else: per network, then per username and network.
 const keys=[],API_LIMITER={async limit({key}){keys.push(key);return {success:true};}},AUTH_LIMITER={async limit({key}){keys.push(key);return {success:!key.startsWith('admin-login:')};}};
 const limited=await browser({...env,API_LIMITER,AUTH_LIMITER},{ip:'203.0.113.10'}).login('ThayMinh',PASSWORD);
 assert.equal(limited.status,429);assert.equal(limited.json.code,'rate_limited');assert.deepEqual(keys,['admin-login-ip:203.0.113.10','admin-login:thayminh|203.0.113.10']);
});

test('The cookie counts only with X-Hoa-Tri-Admin: 1; a student session is never admin; Bearer ADMIN_TOKEN still works for tools',async t=>{
 const {sqlite,env}=environment(t),admin=await firstAdmin(env);
 sqlite.prepare("INSERT INTO stories(id,title,genre,visibility) VALUES('s-private','Sách riêng','Giáo dục','private')").run();
 assert.equal((await admin.send('/api/jobs')).status,200);
 // Without the header (a public page, a link, a form of another site) the same cookie grants nothing.
 const bare=await admin.send('/api/jobs',{admin:false});assert.equal(bare.status,401);assert.deepEqual(bare.json,SIGNED_OUT);
 assert.deepEqual(await admin.status({admin:false}),{authenticated:false});assert.equal((await admin.send('/api/admin/session',{admin:false})).status,401);
 assert.equal((await admin.send('/api/read/s-private',{admin:false})).status,404,'the reader does not show private books with it');
 assert.equal((await admin.send('/api/read/s-private')).status,200,'the console does');
 // Another site's page is refused before routing, header or not.
 assert.equal((await admin.send('/api/admin/admins',{method:'POST',body:{username:'ke-gian',password:NEW_PASSWORD},headers:{Origin:'https://evil.example'}})).json.code,'origin');
 // A student's session, in its own cookie or in the admin one, opens nothing.
 const student=await signedIn(sqlite),lan=browser(env);lan.jar.set('cat_hien_session',student.cookie.split('=')[1]);
 assert.deepEqual((await lan.send('/api/jobs')).json,SIGNED_OUT);assert.deepEqual(await lan.status(),{authenticated:false});
 lan.jar.set('cat_hien_admin',student.cookie.split('=')[1]);assert.equal((await lan.send('/api/jobs')).status,401);assert.equal((await lan.send('/api/admin/session')).status,401);
 // A made-up cookie neither.
 const forged=browser(env);forged.jar.set('cat_hien_admin','A'.repeat(43));assert.equal((await forged.send('/api/users')).status,401);
 // Command-line tools (tools/samples, deploy checks) keep sending ADMIN_TOKEN as Bearer; it is no session.
 const tool=browser(env),bearer={headers:{Authorization:`Bearer ${TOKEN}`},admin:false};
 const status=await tool.status(bearer);assert.deepEqual([status.authenticated,status.via,status.admin,status.translationMode],[true,'token',{username:null,name:'ADMIN_TOKEN'},'premium']);
 assert.equal((await tool.send('/api/jobs',bearer)).status,200);assert.equal((await tool.send('/api/admin/session',bearer)).status,401);
 assert.equal((await tool.send('/api/jobs',{headers:{Authorization:`Bearer ${TOKEN.slice(1)}`}})).status,401);
 // A wrong Bearer decides alone: the cookie sent with it does not rescue the request. Basic credentials (a site kept
 // behind a password prompt) are not ADMIN_TOKEN and leave the session to decide; the bare token works as it did.
 assert.equal((await admin.send('/api/jobs',{headers:{Authorization:'Bearer sai'}})).status,401);
 assert.equal((await admin.send('/api/jobs',{headers:{Authorization:'Basic dGhheW1pbmg6bWF0LWtoYXU='}})).status,200);
 assert.equal((await tool.send('/api/jobs',{headers:{Authorization:'Basic dGhheW1pbmg6bWF0LWtoYXU='},admin:false})).status,401);
 assert.equal((await tool.send('/api/jobs',{headers:{Authorization:TOKEN},admin:false})).status,200);
 // The admin default "Cách dịch" follows ADMIN_TRANSLATION_MODE; a value that is no mode is ignored.
 for(const [value,mode] of [['quality','quality'],[' economy ','economy'],['turbo','premium'],['','premium']])assert.equal((await browser({...env,ADMIN_TRANSLATION_MODE:value}).status(bearer)).translationMode,mode,value);
});

test('A session ends after 2 hours without a request or 12 hours in all; last_seen_at is written at most every 5 minutes',async t=>{
 const tick=clock(t),{sqlite,env}=environment(t),admin=await firstAdmin(env),seen=()=>sqlite.prepare('SELECT last_seen_at FROM admin_sessions').get().last_seen_at;
 assert.equal(seen(),NOW);
 tick(4*MINUTE);assert.equal(await admin.session(),200);assert.equal(seen(),NOW,'not written again within 5 minutes');
 tick(2*MINUTE);assert.equal(await admin.session(),200);assert.equal(seen(),NOW+6*MINUTE);
 tick(2*HOUR-1);assert.equal(await admin.session(),200,'one millisecond before the idle limit');
 tick(2*HOUR);assert.equal(await admin.session(),401,'two hours without a request');assert.deepEqual((await admin.send('/api/jobs')).json,SIGNED_OUT);
 // Logging out after expiry still clears the cookie and the row.
 const out=await admin.send('/api/admin/logout',{method:'POST'});
 assert.equal(out.status,200);assert.deepEqual(out.json,{ok:true});assert.match(out.cookies[0],/^cat_hien_admin=; Path=\/api\/; HttpOnly; SameSite=Strict; Max-Age=0; Secure$/u);
 assert.equal(admin.jar.has('cat_hien_admin'),false);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get().n,0);
 // A busy console still signs in again after 12 hours.
 assert.equal((await admin.login(USERNAME,PASSWORD)).status,200);
 for(let hour=1;hour<12;hour++){tick(HOUR);assert.equal(await admin.session(),200,`hour ${hour}`);}
 tick(HOUR-1);assert.equal(await admin.session(),200);
 tick(1);assert.equal(await admin.session(),401,'12 hours after the login');
 // Expired rows go when another session starts.
 await browser(env).login(USERNAME,PASSWORD);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get().n,1);
});

test('The study page\'s question (?probe=1) answers without a 401 and never keeps an admin session alive',async t=>{
 const tick=clock(t),{sqlite,env}=environment(t),admin=await firstAdmin(env),seen=()=>sqlite.prepare('SELECT last_seen_at FROM admin_sessions').get().last_seen_at;
 const probe=async client=>{const answer=await client.send('/api/admin/session?probe=1');return [answer.status,answer.json?.admin??null];};
 assert.deepEqual(await probe(browser(env)),[200,null],'a student browser gets a plain answer, not an error line in its console');
 tick(10*MINUTE);assert.deepEqual(await probe(admin),[200,{username:USERNAME,name:NAME}]);assert.equal(seen(),NOW,'a look is not admin work');
 tick(2*HOUR-10*MINUTE);assert.deepEqual(await probe(admin),[200,null],'the idle limit still ends a session that only the study page saw');
 assert.equal(await admin.session(),401);
});

// What the console asks by itself (new requests every 5 minutes, a running job's row) carries X-Hoa-Tri-Background: 1:
// like the study page's question it is not using the console, so a console left open on a shared computer ends 2 hours
// after its last use, as Cài đặt and the privacy page say.
test('Requests the console sends by itself (X-Hoa-Tri-Background: 1) are answered but never keep the session alive',async t=>{
 const tick=clock(t),{sqlite,env}=environment(t),admin=await firstAdmin(env),seen=()=>sqlite.prepare('SELECT last_seen_at FROM admin_sessions').get().last_seen_at;
 const check=async()=>(await admin.send('/api/requests',{headers:{'X-Hoa-Tri-Background':'1'}})).status;
 tick(10*MINUTE);assert.equal(await check(),200);assert.equal(seen(),NOW,'a check is not admin work');
 for(let minute=15;minute<2*60;minute+=5){tick(5*MINUTE);assert.equal(await check(),200,`minute ${minute}`);}
 assert.equal(seen(),NOW);tick(5*MINUTE);assert.equal(await check(),401,'two hours after the last use, checked all along');
 // The admin's own requests do keep it.
 assert.equal((await admin.login(USERNAME,PASSWORD)).status,200);const signed=NOW+2*HOUR;assert.equal(seen(),signed);
 tick(6*MINUTE);assert.equal(await check(),200);assert.equal(seen(),signed);
 assert.equal((await admin.send('/api/requests')).status,200);assert.equal(seen(),signed+6*MINUTE);
});

test('Logout ends this session only; a logout with no session or from no admin still answers and clears',async t=>{
 const {sqlite,env}=environment(t),admin=await firstAdmin(env),phone=browser(env,{ip:'203.0.113.4'});
 assert.equal((await phone.login(USERNAME,PASSWORD)).status,200);
 const out=await admin.send('/api/admin/logout',{method:'POST'});assert.equal(out.status,200);
 assert.equal(await admin.session(),401);assert.equal(await phone.session(),200,'the other device stays signed in');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get().n,1);
 const nobody=await browser(env).send('/api/admin/logout',{method:'POST'});assert.equal(nobody.status,200);assert.match(nobody.cookies[0],/Max-Age=0/u);
 // The device mark stays: it only makes this browser's own mistakes count apart.
 assert.ok(admin.jar.has('cat_hien_admin_device'));
 // When the server cannot delete the row, the browser forgets the cookie anyway and is told.
 const {prepare}=env.DB;env.DB.prepare=sql=>{if(sql.startsWith('DELETE FROM admin_sessions'))throw new Error('D1_ERROR: storage unavailable');return prepare.call(env.DB,sql);};
 const lines=logs(t),failed=await phone.send('/api/admin/logout',{method:'POST'});env.DB.prepare=prepare;
 assert.equal(failed.status,503);assert.equal(failed.json.code,'logout_incomplete');assert.match(failed.cookies[0],/^cat_hien_admin=; .*Max-Age=0/u);assert.equal(phone.jar.has('cat_hien_admin'),false);
 assert.ok(events(lines).some(entry=>entry.event==='admin_session_error'&&/storage unavailable/u.test(entry.message)));
});

test('Changing the password needs the current one, follows the rules, ends the other sessions and gives this browser a new one',async t=>{
 const {sqlite,env}=environment(t),admin=await firstAdmin(env),phone=browser(env,{ip:'203.0.113.4'});
 assert.equal((await phone.login(USERNAME,PASSWORD)).status,200);
 const change=(client,body,options)=>client.send('/api/admin/password',{method:'POST',body,...options});
 for(const [body,status,code] of [[{newPassword:NEW_PASSWORD},400,'password_required'],[{currentPassword:'sai-mat-khau-roi',newPassword:NEW_PASSWORD},403,'wrong_password'],[{currentPassword:PASSWORD,newPassword:'ngan-qua'},400,'password_length'],[{currentPassword:PASSWORD,newPassword:'ThayMinh2026'},400,'password_like_email'],[{currentPassword:PASSWORD,newPassword:TOKEN},400,'password_is_token'],[{currentPassword:PASSWORD,newPassword:PASSWORD},400,'password_unchanged']]){
  const refused=await change(admin,body);assert.equal(refused.status,status,code);assert.equal(refused.json.code,code);assert.equal(refused.cookies.length,0);
 }
 assert.deepEqual((await change(browser(env),{currentPassword:PASSWORD,newPassword:NEW_PASSWORD})).json,SIGNED_OUT);
 assert.equal((await change(browser(env),{currentPassword:PASSWORD,newPassword:NEW_PASSWORD},{headers:{Authorization:`Bearer ${TOKEN}`},admin:false})).json.code,'session_required');
 const before=admin.jar.get('cat_hien_admin'),done=await change(admin,{currentPassword:PASSWORD,newPassword:NEW_PASSWORD});
 assert.equal(done.status,200);assert.deepEqual(done.json,{ok:true,ended:1});
 assert.match(done.cookies[0],SESSION_COOKIE);assert.match(done.cookies[1],/^cat_hien_admin_device=/u);
 assert.notEqual(admin.jar.get('cat_hien_admin'),before);assert.equal(await admin.session(),200);assert.equal(await phone.session(),401,'the other device is signed out');
 const stale=browser(env);stale.jar.set('cat_hien_admin',before);assert.equal(await stale.session(),401,'this browser\'s old session ended too');
 assert.equal((await browser(env).login(USERNAME,PASSWORD)).status,401);assert.equal((await browser(env).login(USERNAME,NEW_PASSWORD)).status,200);
 assert.ok(sqlite.prepare('SELECT password_changed_at FROM admin_users').get().password_changed_at);
 // Wrong current passwords are counted for the account: ten lock it, also for the right one.
 for(let i=0;i<10;i++)assert.equal((await change(admin,{currentPassword:`doan-${i}-sai-roi`,newPassword:'mot-mat-khau-moi-han'})).status,403);
 const locked=await change(admin,{currentPassword:NEW_PASSWORD,newPassword:'mot-mat-khau-moi-han'});
 assert.equal(locked.status,429);assert.equal(locked.json.scope,'failures');assert.match(locked.json.error,/^Mật khẩu quản trị đã bị nhập sai quá nhiều lần\. Hãy đợi khoảng 1 phút rồi thử lại\. Nếu quên mật khẩu, hãy bấm “Quên mật khẩu\?” và đặt lại bằng mã ADMIN_TOKEN\.$/u);
});

test('Wrong passwords lock a username where they come from; the admin\'s own browser keeps signing in; the token recovery clears the rest',async t=>{
 const tick=clock(t),{sqlite,env}=environment(t),admin=await firstAdmin(env);
 assert.equal((await admin.send('/api/admin/logout',{method:'POST'})).status,200);
 const attacker=browser(env,{ip:'203.0.113.66'});
 for(let i=0;i<10;i++)assert.equal((await attacker.login(USERNAME,`doan-sai-${i}-roi`)).status,401);
 const locked=await attacker.login(USERNAME,PASSWORD);
 assert.equal(locked.status,429,'locked, even for the right password');assert.equal(locked.headers.get('Retry-After'),'60');assert.equal(locked.cookies.length,0);
 assert.deepEqual(locked.json,{error:'Mật khẩu quản trị đã bị nhập sai quá nhiều lần. Hãy đợi khoảng 1 phút rồi thử lại. Nếu quên mật khẩu, hãy bấm “Quên mật khẩu?” và đặt lại bằng mã ADMIN_TOKEN.',code:'rate_limited',retryAfter:60,scope:'failures'});
 // The admin's browser (its device mark) signs in, even from the attacker's network; so does a new browser elsewhere.
 assert.equal((await admin.login(USERNAME,PASSWORD,{from:'203.0.113.66'})).status,200);assert.equal((await browser(env,{ip:'192.0.2.9'}).login(USERNAME,PASSWORD)).status,200);
 // Fifty guesses in all, from many networks, lock the username for every browser without a mark.
 for(let i=0;i<40;i++)assert.equal((await browser(env,{ip:`198.18.0.${i+1}`}).login(USERNAME,'doan-sai-nua-roi')).status,401);
 assert.equal((await browser(env,{ip:'192.0.2.10'}).login(USERNAME,PASSWORD)).status,429);
 assert.equal((await admin.login(USERNAME,PASSWORD,{from:'192.0.2.11'})).status,200,'her own browser is counted apart');
 // One network guessing many usernames meets the count per network, which says so.
 const spray=browser(env,{ip:'203.0.113.77'});for(let i=0;i<100;i++)assert.equal((await spray.login(`quan-tri-${i}`,'doan-sai-nua-roi')).status,401);
 const network=await spray.login('ai-do-khac','doan-sai-nua-roi');assert.equal(network.status,429);assert.equal(network.json.scope,'network');assert.match(network.json.error,/^Mạng Internet bạn đang dùng vừa có quá nhiều lần nhập sai mật khẩu quản trị/u);
 // The recovery: with ADMIN_TOKEN the forgotten password is reset, her sessions end and the counts that lock her go.
 const home=browser(env,{ip:'192.0.2.10'});
 for(const [body,status,code] of [[{token:'sai'},403,'admin_token_wrong'],[{username:'khong-ai-ca',password:NEW_PASSWORD},404,'admin_not_found'],[{password:'ngan-qua'},400,'password_length']]){const refused=await home.setup(body);assert.equal(refused.status,status,code);assert.equal(refused.json.code,code);}
 assert.equal(await failureLevel(sqlite,'admin-login-user:thayminh'),50);
 const recovered=await home.setup({username:'thayminh',password:NEW_PASSWORD});
 assert.equal(recovered.status,200);assert.deepEqual(recovered.json,{admin:{username:USERNAME,name:NAME},created:false});assert.match(recovered.cookies[0],SESSION_COOKIE);
 assert.equal(await home.session(),200,'signed in as her');assert.equal(await admin.session(),401,'her other sessions ended');
 assert.equal(await failureLevel(sqlite,'admin-login-user:thayminh'),0);assert.equal(await failureLevel(sqlite,'admin-login:thayminh|203.0.113.66'),10,'counts of other networks drain by themselves');
 assert.equal((await browser(env,{ip:'192.0.2.12'}).login(USERNAME,NEW_PASSWORD)).status,200);assert.equal((await browser(env,{ip:'192.0.2.13'}).login(USERNAME,PASSWORD)).status,401);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n,1,'a recovery makes no account');
 // Wrong tokens are counted per network: ten lock that network for wrong ones, which are then refused without being
 // counted. The right token passes there all the same, so a student sharing the school's address cannot keep the
 // operator out of the first-run and recovery forms.
 const guesser=browser(env,{ip:'203.0.113.99'});for(let i=0;i<10;i++)assert.equal((await guesser.setup({token:`sai-${i}`})).status,403);
 const tokenLock=await guesser.setup({token:'sai-lan-nua'});assert.equal(tokenLock.status,429);
 assert.equal(tokenLock.json.error,'Mã ADMIN_TOKEN không đúng, và mạng Internet bạn đang dùng vừa có quá nhiều lần nhập sai mã này (giới hạn chung cho cả mạng, không riêng bạn). Hãy kiểm tra lại mã: mã đúng vẫn dùng được ngay. Muốn thử mã khác, hãy đợi khoảng 1 phút hoặc dùng mạng khác như dữ liệu di động.');
 assert.equal(await failureLevel(sqlite,'admin-token:203.0.113.99'),10,'a refused wrong token is not counted');
 assert.equal((await browser(env,{ip:'203.0.113.99'}).setup({username:'thayminh',password:'mot-mat-khau-moi-han'})).status,200,'the right token passes on the locked network');
 assert.equal((await guesser.setup({token:'sai-van-sai'})).status,429,'and leaves the lock on wrong ones');
 assert.equal((await browser(env,{ip:'192.0.2.14'}).setup({token:'sai-o-mang-khac'})).status,403,'another network is not counted with it');
 tick(61*1000);assert.equal((await guesser.setup({token:'sai-sau-mot-phut'})).status,403,'a minute later a wrong token is checked and counted again');
});

test('A locked admin account cannot sign in and its sessions stop counting',async t=>{
 const {sqlite,env}=environment(t),admin=await firstAdmin(env);
 assert.equal((await admin.send('/api/admin/admins',{method:'POST',body:{username:'lan.nguyen',name:'Cô Lan',password:NEW_PASSWORD,currentPassword:PASSWORD}})).status,201);
 const lan=browser(env,{ip:'203.0.113.5'});assert.equal((await lan.login('lan.nguyen',NEW_PASSWORD)).status,200);
 sqlite.prepare("UPDATE admin_users SET disabled_at=CURRENT_TIMESTAMP WHERE username_normalized='lan.nguyen'").run();
 assert.equal(await lan.session(),401);assert.deepEqual((await lan.send('/api/users')).json,SIGNED_OUT);
 const right=await browser(env).login('lan.nguyen',NEW_PASSWORD);assert.equal(right.status,403);assert.equal(right.json.code,'admin_disabled');assert.equal(right.cookies.length,0);
 assert.deepEqual((await browser(env).login('lan.nguyen','sai-mat-khau-roi')).json,WRONG,'only the right password learns of the lock');
 const recovery=await browser(env).setup({username:'lan.nguyen',password:'mot-mat-khau-moi-han'});assert.equal(recovery.status,403);assert.equal(recovery.json.code,'admin_disabled');
 assert.equal(await admin.session(),200,'other admins are unaffected');
});

test('Admins list, add and remove each other; never oneself, never the last one; a removed admin is signed out',async t=>{
 const {sqlite,env}=environment(t),minh=await firstAdmin(env);
 const list=async client=>(await client.send('/api/admin/admins')).json.admins;
 const [only]=await list(minh);assert.deepEqual(Object.keys(only),['id','username','name','createdAt','lastLoginAt','self']);
 assert.equal(only.username,USERNAME);assert.equal(only.self,true);assert.match(only.createdAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/u);
 // Each admin confirms a change of the list with her own password (currentPassword).
 const add=(client,body,options)=>client.send('/api/admin/admins',{method:'POST',body,...options});
 const added=await add(minh,{username:'Lan.Nguyen',name:'  Cô Lan ',password:NEW_PASSWORD,currentPassword:PASSWORD});
 assert.equal(added.status,201);assert.equal(added.cookies.length,0,'adding signs nobody in');
 assert.deepEqual({...added.json.admin,id:'',createdAt:''},{id:'',username:'Lan.Nguyen',name:'Cô Lan',createdAt:'',lastLoginAt:null,self:false});
 for(const [body,status,code] of [[{username:'lan.nguyen',password:NEW_PASSWORD},409,'username_taken'],[{username:'LAN.NGUYEN ',password:NEW_PASSWORD},409,'username_taken'],[{username:'ab',password:NEW_PASSWORD},400,'bad_username'],[{username:'an.tran',password:'an.tran2026'},400,'password_length'],[{username:'an.tran',password:'AnTran20262026'},400,'password_like_email']]){
  const refused=await add(minh,{...body,currentPassword:PASSWORD});assert.equal(refused.status,status,code);assert.equal(refused.json.code,code);
 }
 assert.equal((await add(browser(env),{username:'ke-gian',password:NEW_PASSWORD,currentPassword:PASSWORD})).status,401,'only an admin adds one');
 const lan=browser(env,{ip:'203.0.113.5'});assert.equal((await lan.login('lan.nguyen',NEW_PASSWORD)).status,200);
 const lanId=added.json.admin.id,minhId=only.id,remove=(client,id,currentPassword,options)=>client.send(`/api/admin/admins/${id}`,{method:'DELETE',...(currentPassword?{body:{currentPassword}}:{}),...options});
 assert.deepEqual((await list(lan)).map(item=>[item.username,item.self]),[[USERNAME,false],['Lan.Nguyen',true]]);
 assert.ok((await list(lan))[1].lastLoginAt,'her login is recorded');
 const self=await remove(minh,minhId,PASSWORD);assert.equal(self.status,409);assert.equal(self.json.code,'admin_self');
 assert.equal((await remove(minh,'khong-co',PASSWORD)).status,404);assert.equal((await remove(browser(env),lanId,PASSWORD)).status,401);
 assert.equal((await remove(lan,minhId,NEW_PASSWORD)).status,200);assert.equal(await minh.session(),401,'the removed admin is signed out at once');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admin_sessions WHERE admin_id=?').get(minhId).n,0);
 assert.deepEqual((await list(lan)).map(item=>item.username),['Lan.Nguyen']);
 // The last admin stays, whoever asks (the Bearer token has no account of its own).
 const tool={headers:{Authorization:`Bearer ${TOKEN}`},admin:false};
 assert.equal((await remove(lan,lanId,NEW_PASSWORD)).json.code,'admin_self');const last=await remove(browser(env),lanId,null,tool);assert.equal(last.status,409);assert.equal(last.json.code,'admin_last');
 assert.deepEqual((await browser(env).send('/api/admin/admins')).json,SIGNED_OUT);assert.deepEqual((await browser(env).send('/api/admin/admins',tool)).json.admins.map(item=>item.self),[false]);
 // Two admins removing each other at once: one of them stays.
 assert.equal((await add(lan,{username:'an.tran',name:'An',password:'mot-mat-khau-moi-han',currentPassword:NEW_PASSWORD})).status,201);
 const an=browser(env,{ip:'203.0.113.6'});assert.equal((await an.login('an.tran','mot-mat-khau-moi-han')).status,200);
 const anId=(await list(an)).find(item=>item.self).id,answers=await Promise.all([remove(lan,anId,NEW_PASSWORD),remove(an,lanId,'mot-mat-khau-moi-han')]);
 assert.deepEqual(answers.filter(answer=>answer.status===200).length,1);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n,1);
 // Unknown methods and paths of /api/admin/ say so.
 assert.equal((await lan.send('/api/admin/login')).status,405);assert.equal((await lan.send('/api/admin/admins',{method:'PUT',body:{}})).status,405);assert.equal((await browser(env).send('/api/admin/khong-co')).status,401);
 // Each change to the accounts is one log line naming what happened, never who or with which password.
 const lines=logs(t);assert.deepEqual(events(lines).filter(entry=>entry.event==='admin_account').map(entry=>entry.action),['created_first','added','removed','added','removed']);
 assert.ok(events(lines).map(entry=>JSON.stringify(entry)).every(line=>!/minh|lan|an\.tran|cô|thầy/iu.test(line)&&![PASSWORD,NEW_PASSWORD,TOKEN].some(secret=>line.includes(secret))),lines.join('\n'));
});

// An admin added or removed outlasts the session that did it: a console left open, or a cookie left in a browser, must
// not be enough to add an account of one's own and remove the school's. The signed-in admin confirms with her own
// password ("Mật khẩu của bạn"), checked and counted as for a password change; command-line tools (Bearer ADMIN_TOKEN)
// hold the server's key already and are not asked.
test('Adding or removing an admin asks for the signed-in admin\'s own password, counted with the password change; Bearer is not asked',async t=>{
 const tick=clock(t),{sqlite,env}=environment(t),minh=await firstAdmin(env),count=()=>sqlite.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n;
 const add=(body,client=minh)=>client.send('/api/admin/admins',{method:'POST',body:{username:'lan.nguyen',name:'Cô Lan',password:NEW_PASSWORD,...body}});
 for(const [body,status,error,code] of [[{},400,'Hãy nhập mật khẩu của bạn.','password_required'],[{currentPassword:''},400,'Hãy nhập mật khẩu của bạn.','password_required'],[{currentPassword:'sai-mat-khau-roi'},403,'Mật khẩu của bạn không đúng.','wrong_password'],[{currentPassword:`${PASSWORD}x`.repeat(6)},403,'Mật khẩu của bạn không đúng.','wrong_password']]){
  const refused=await add(body);assert.deepEqual([refused.status,refused.json],[status,{error,code}],JSON.stringify(body));
 }
 assert.equal(count(),1,'nobody was added');
 const added=await add({currentPassword:PASSWORD});assert.equal(added.status,201);const lanId=added.json.admin.id;
 const remove=(body,client=minh)=>client.send(`/api/admin/admins/${lanId}`,{method:'DELETE',...(body===undefined?{}:{body})});
 for(const [body,status,code] of [[undefined,400,'password_required'],[{},400,'password_required'],[{currentPassword:'sai-mat-khau-roi'},403,'wrong_password']]){const refused=await remove(body);assert.deepEqual([refused.status,refused.json.code],[status,code],JSON.stringify(body));}
 assert.equal(count(),2,'nobody was removed');
 // Wrong ones there and in a password change are one count for the account (the right one clears it, as the add above
 // did): at ten, all three are locked, the right password too.
 for(let i=0;i<9;i++)assert.equal((await minh.send('/api/admin/password',{method:'POST',body:{currentPassword:`doan-${i}-sai-roi`,newPassword:'mot-mat-khau-moi-han'}})).status,403);
 for(const locked of [await add({username:'an.tran',currentPassword:PASSWORD}),await remove({currentPassword:PASSWORD}),await minh.send('/api/admin/password',{method:'POST',body:{currentPassword:PASSWORD,newPassword:'mot-mat-khau-moi-han'}})]){
  assert.equal(locked.status,429);assert.match(locked.json.error,/^Mật khẩu quản trị đã bị nhập sai quá nhiều lần\. Hãy đợi khoảng 1 phút rồi thử lại\./u);
 }
 assert.equal(count(),2);
 // A minute later the right password removes her; the per-minute limit asked is the password change's.
 tick(61*1000);const keys=[],AUTH_LIMITER={async limit({key}){keys.push(key);return {success:true};}},limited=browser({...env,AUTH_LIMITER});
 for(const [name,value] of minh.jar)limited.jar.set(name,value);
 const minhId=(await minh.send('/api/admin/admins')).json.admins.find(item=>item.self).id;
 assert.equal((await remove({currentPassword:PASSWORD},limited)).status,200);assert.deepEqual(keys,[`admin-password:${minhId}`]);assert.equal(count(),1);
 // Command-line tools send ADMIN_TOKEN as Bearer: no account, no password to ask.
 const tool={headers:{Authorization:`Bearer ${TOKEN}`},admin:false},made=await browser(env).send('/api/admin/admins',{method:'POST',body:{username:'an.tran',password:'mot-mat-khau-moi-han'},...tool});
 assert.equal(made.status,201);assert.equal((await browser(env).send(`/api/admin/admins/${made.json.admin.id}`,{method:'DELETE',...tool})).status,200);
});
