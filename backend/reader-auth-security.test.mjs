import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import worker from './worker.js';
import * as auth from './reader-auth.js';
import {vietnamDay} from './rate-limit.js';

// Account security, run as the browser and the admin page call it: wrong-password counts and their waits, the rules for
// new passwords, signing out everywhere, changing the password, checking a reset link without using it, Google sign-ins
// that fail, and the registration cap of a shared network. Real SQLite with every migration; Google is a test double.
const origin='https://hoa-tri.example',ADMIN='a7'.repeat(32),PASSWORD='mat-khau-cua-lan',NOW=Date.parse('2026-10-22T03:00:00Z');
class D1Statement{
 constructor(database,sql){this.sql=sql;this.statement=database.prepare(sql);this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){return this.statement.get(...this.args)||null;}
 async all(){return {results:this.statement.all(...this.args),success:true};}
 execute(){const result=this.statement.run(...this.args);return {success:true,meta:{changes:result.changes}};}
 async run(){return this.execute();}
}
const migrations=fileURLToPath(new URL('../database/migrations/',import.meta.url));
function environment(t,vars={}){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 for(const name of readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../database/migrations/'+name,import.meta.url),'utf8'));
 const DB={prepare:sql=>new D1Statement(sqlite,sql),async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 return {sqlite,env:{DB,ADMIN_TOKEN:ADMIN,...vars}};
}
// One browser: it keeps the cookies the server sets (a cleared one is dropped) and sends them back.
function browser(env,ip='198.51.100.1'){
 const jar=new Map();
 const send=async(path,{method='GET',body,headers={},from=ip}={})=>{
  const cookies=[...jar].map(([name,value])=>`${name}=${value}`).join('; ');
  const init={method,headers:{Origin:origin,'CF-Connecting-IP':from,...(cookies?{Cookie:cookies}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers}};
  if(body!==undefined)init.body=typeof body==='string'?body:JSON.stringify(body);
  const response=await worker.fetch(new Request(origin+path,init),env,{}),text=await response.text();
  for(const line of response.headers.getSetCookie()){const pair=line.split(';')[0],i=pair.indexOf('=');if(/Max-Age=0(?:;|$)/u.test(line))jar.delete(pair.slice(0,i));else jar.set(pair.slice(0,i),pair.slice(i+1));}
  let json=null;try{json=JSON.parse(text);}catch{}
  return {status:response.status,headers:response.headers,json,text,cookies:response.headers.getSetCookie()};
 };
 return {jar,send,login:(email,password,from)=>send('/api/auth/login',{method:'POST',body:{email,password},from}),me:async()=>(await send('/api/me')).json};
}
const register=(client,email='lan@example.test',password=PASSWORD,name='Lan')=>client.send('/api/auth/register',{method:'POST',body:{name,email,password,acceptTerms:true}});
const userId=(sqlite,email)=>sqlite.prepare('SELECT user_id FROM reader_credentials WHERE email_normalized=?').get(email).user_id;
const failureLevel=async(sqlite,name)=>sqlite.prepare('SELECT level FROM auth_failures WHERE key=?').get(await auth.failureKey({ADMIN_TOKEN:ADMIN},name))?.level??0;
const clock=t=>{t.mock.timers.enable({apis:['Date'],now:NOW});return ms=>t.mock.timers.tick(ms);};
// A stored password made as registration makes it, for accounts from before the rules.
async function storedPassword(password){
 const salt=crypto.getRandomValues(new Uint8Array(16)),key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
 const hash=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:100000},key,256)),base64=bytes=>btoa(String.fromCharCode(...bytes));
 return {password_hash:`pbkdf2-sha256$100000$${base64(hash)}`,password_salt:base64(salt)};
}

test('New passwords that are common, follow a pattern or repeat the email or name are refused; other passwords pass',()=>{
 const context={email:'lan.nguyen@truong.edu.vn',name:'Nguyễn Thị Lan'},code=password=>auth.passwordProblem?.(password,context)?.code??'ok';
 for(const password of ['12345678','123456789','87654321','abcdefgh','aaaaaaaa','abababab','12341234','qwertyui','asdf2008','1qaz2wsx','poiuytrewq','01012008','2008-12-19','12345678a','meomeomeo1'])assert.equal(code(password),'password_pattern',password);
 for(const password of ['password','Password123','abc12345678','P@ssw0rd2024','iloveyou','matkhau123','Mật khẩu 123','MẬT KHẨU!','anhyeuem2008','hoatri2026','l0ve1234','!@#$%^&*'])assert.equal(code(password),'password_common',password);
 for(const password of ['lan.nguyen@truong.edu.vn','lannguyen','LanNguyen2008','nguyen2008','Lan12345678','nguyenthilan','2008nguyễn'])assert.equal(code(password),'password_like_email',password);
 for(const password of ['mat-khau-cua-lan','Con mèo nhà tôi tên Mướp','tre-xanh','correct horse battery staple','0912345678','lan-yeu-meo-den','Hà Nội mùa thu 1998'])assert.equal(code(password),'ok',password);
});

test('Registration, a reset link and a password change refuse weak new passwords; an old weak password still logs in and is flagged',async t=>{
 const {sqlite,env}=environment(t),lan=browser(env);
 for(const [password,expected] of [['12345678','password_pattern'],['matkhau123','password_common'],['lan12345678','password_like_email']]){
  const refused=await register(lan,'lan@example.test',password);assert.equal(refused.status,400,password);assert.equal(refused.json.code,expected,password);assert.ok(refused.json.error.length>40);
 }
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM reader_users').get().n,0);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'register:%'").get().n,0,'a refused form uses none of the network\'s registrations');
 assert.equal((await register(lan)).status,201);
 // A reset link: the weak password is refused and the link still works.
 const link=await worker.fetch(new Request(`${origin}/api/users/${userId(sqlite,'lan@example.test')}/password-reset`,{method:'POST',headers:{Authorization:`Bearer ${ADMIN}`,Origin:origin}}),env,{});
 const token=new URLSearchParams((await link.json()).resetUrl.split('?')[1]).get('token');
 const weak=await lan.send('/api/auth/password-reset',{method:'POST',body:{token,password:'1234567890'}});assert.equal(weak.status,400);assert.equal(weak.json.code,'password_pattern');
 assert.equal((await lan.send('/api/auth/password-reset',{method:'POST',body:{token,password:'tre-xanh-mua-ha'}})).status,200);
 // A change while signed in.
 const change=await lan.send('/api/auth/password',{method:'POST',body:{currentPassword:'tre-xanh-mua-ha',newPassword:'iloveyou2026'}});assert.equal(change.status,400);assert.equal(change.json.code,'password_common');
 // An account from before the rules keeps its password; the login answer says it is weak, a strong one says nothing.
 const old=await storedPassword('12345678');
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run('user-old','local:user-old','cu@example.test','Cũ');
 sqlite.prepare('INSERT INTO reader_credentials(user_id,email_normalized,password_hash,password_salt) VALUES(?,?,?,?)').run('user-old','cu@example.test',old.password_hash,old.password_salt);
 const flagged=await browser(env).login('cu@example.test','12345678');assert.equal(flagged.status,200);assert.deepEqual(flagged.json,{ok:true,weakPassword:'password_pattern'});
 assert.deepEqual((await browser(env).login('lan@example.test','tre-xanh-mua-ha')).json,{ok:true});
});

test('Ten wrong passwords for one email from one network lock it, then each further wait doubles; nothing locks for good',async t=>{
 const {sqlite,env}=environment(t),tick=clock(t),lan=browser(env),attacker=browser(env,'203.0.113.66');
 assert.equal((await register(lan)).status,201);
 const guesses=[];for(let i=0;i<10;i++)guesses.push((await attacker.login('lan@example.test',`doan-sai-${i}`)).status);
 assert.deepEqual(guesses,Array(10).fill(401));
 const locked=await attacker.login('lan@example.test',PASSWORD);
 assert.equal(locked.status,429,'locked, even for the right password');assert.equal(locked.headers.get('Retry-After'),'60');
 assert.deepEqual(locked.json,{error:'Mật khẩu đã bị nhập sai quá nhiều lần. Hãy đợi khoảng 1 phút rồi thử lại. Nếu quên mật khẩu, hãy xin quản trị viên một liên kết đặt lại mật khẩu.',code:'rate_limited',retryAfter:60,scope:'failures'});
 assert.equal(locked.cookies.length,0);
 // Lan is not locked out: not from her own browser, nor from a new one on her network.
 assert.equal((await lan.login('lan@example.test',PASSWORD)).status,200);assert.equal((await browser(env).login('lan@example.test',PASSWORD)).status,200);
 // After the wait one more try; a wrong one locks for twice as long, and again.
 const waits=[];
 for(const wait of [61,121,241]){tick(wait*1000);assert.equal((await attacker.login('lan@example.test','doan-tiep')).status,401);waits.push((await attacker.login('lan@example.test',PASSWORD)).json.retryAfter);}
 assert.deepEqual(waits,[120,240,480]);
 // A quiet day drains the count: the next wrong password is only a wrong password.
 tick(24*60*60*1000);
 assert.deepEqual([(await attacker.login('lan@example.test','doan-sai')).status,(await attacker.login('lan@example.test','doan-sai')).status],[401,401]);
 // Only hashes are kept: no email and no address.
 for(const {key} of sqlite.prepare('SELECT key FROM auth_failures').all())assert.match(key,/^[0-9a-f]{64}$/u);
});

test('The right password clears its email and network count, so a student who mistypes now and then is never locked',async t=>{
 const {env}=environment(t);clock(t);const lan=browser(env);assert.equal((await register(lan)).status,201);
 const fresh=browser(env);
 for(let round=0;round<3;round++){for(let i=0;i<9;i++)assert.equal((await fresh.login('lan@example.test','go-nham-mat-khau')).status,401);assert.equal((await fresh.login('lan@example.test',PASSWORD)).status,200,`round ${round}`);fresh.jar.delete('cat_hien_device');}
});

test('Guesses for one email from many networks meet a looser count per email; the student\'s own browser keeps signing in',async t=>{
 const {sqlite,env}=environment(t);clock(t);const lan=browser(env);assert.equal((await register(lan)).status,201);
 assert.match(lan.jar.get('cat_hien_device'),/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u);
 const device=(await register(browser(env),'an@example.test')).cookies.find(line=>line.startsWith('cat_hien_device='));
 assert.match(device,/^cat_hien_device=[^;]+; Path=\/api\/auth\/; HttpOnly; SameSite=Strict; Max-Age=31536000; Secure$/u);
 for(let i=0;i<50;i++)assert.equal((await browser(env,`203.0.113.${i+1}`).login('lan@example.test','doan-sai')).status,401);
 const elsewhere=await browser(env,'192.0.2.7').login('lan@example.test',PASSWORD);
 assert.equal(elsewhere.status,429,'a browser the account never signed in from waits');assert.equal(elsewhere.json.scope,'failures');
 // A forged mark is no mark.
 const forged=browser(env,'192.0.2.8');forged.jar.set('cat_hien_device',`${'A'.repeat(22)}.${'B'.repeat(43)}`);assert.equal((await forged.login('lan@example.test',PASSWORD)).status,429);
 // Her browser is counted on its own: it signs in, and its own mistakes do not add to the count per email.
 assert.equal((await lan.login('lan@example.test',PASSWORD,'192.0.2.9')).status,200);
 const before=await failureLevel(sqlite,'login-email:lan@example.test');assert.equal(before,50);
 for(let i=0;i<10;i++)assert.equal((await lan.login('lan@example.test','go-nham-roi')).status,401);
 assert.equal((await lan.login('lan@example.test',PASSWORD)).status,429,'ten mistakes in her own browser lock that browser too');
 assert.equal(await failureLevel(sqlite,'login-email:lan@example.test'),before);
});

test('One network guessing many emails meets a count per network that says so; other networks and known browsers go on',async t=>{
 const {env}=environment(t);clock(t);const lan=browser(env,'198.51.100.1');assert.equal((await register(lan)).status,201);
 const network='203.0.113.77',spray=browser(env,network);
 for(let i=0;i<100;i++)assert.equal((await spray.login(`hs${i}@example.test`,'12345678')).status,401);
 const refused=await spray.login('minh@example.test','mot-mat-khau-khac');
 assert.equal(refused.status,429);assert.equal(refused.json.scope,'network');
 assert.equal(refused.json.error,'Mạng Internet bạn đang dùng vừa có quá nhiều lần nhập sai mật khẩu (giới hạn chung cho cả mạng, không riêng bạn). Hãy đợi khoảng 1 phút rồi thử lại, hoặc dùng mạng khác như dữ liệu di động.');
 assert.equal((await browser(env,network).login('lan@example.test',PASSWORD)).status,429,'a new browser on that network waits');
 assert.equal((await lan.login('lan@example.test',PASSWORD,network)).status,200,'Lan\'s browser on the same network signs in');
 assert.equal((await browser(env,'192.0.2.1').login('hs1@example.test','12345678')).status,401,'another network is not counted with it');
});

test('An email without an account costs the same password hashing and meets the same counts as one with an account',async t=>{
 const {env}=environment(t);clock(t);assert.equal((await register(browser(env))).status,201);
 const deriveBits=crypto.subtle.deriveBits.bind(crypto.subtle),iterations=[];
 t.mock.method(crypto.subtle,'deriveBits',async(algorithm,key,length)=>{iterations.push(algorithm.iterations);return deriveBits(algorithm,key,length);});
 const answers=async email=>{const client=browser(env,'203.0.113.5');iterations.length=0;const first=await client.login(email,'doan-sai');const hashed=[...iterations];for(let i=0;i<9;i++)await client.login(email,'doan-sai');const locked=await client.login(email,'doan-sai');return {status:first.status,body:first.json,hashed,locked:[locked.status,locked.json]};};
 const known=await answers('lan@example.test'),unknown=await answers('khong-co@example.test');
 assert.deepEqual(unknown.hashed,[100000],'one PBKDF2 of the same strength');assert.deepEqual(known.hashed,[100000]);
 assert.deepEqual(unknown,{...known,hashed:unknown.hashed});
});

test('Wrong current passwords in a signed-in session are counted per account, for a password change and an account deletion alike',async t=>{
 const {env}=environment(t);clock(t);const lan=browser(env);assert.equal((await register(lan)).status,201);
 for(let i=0;i<10;i++){const wrong=await lan.send('/api/auth/password',{method:'POST',body:{currentPassword:`doan-${i}`,newPassword:'mot-mat-khau-moi-han'}});assert.equal(wrong.status,403);assert.equal(wrong.json.code,'wrong_password');}
 const locked=await lan.send('/api/auth/password',{method:'POST',body:{currentPassword:PASSWORD,newPassword:'mot-mat-khau-moi-han'}});
 assert.equal(locked.status,429);assert.equal(locked.json.scope,'failures');
 const deletion=await lan.send('/api/me',{method:'DELETE',body:{confirm:'XÓA',password:PASSWORD}});assert.equal(deletion.status,429,'the same count guards deleting the account');
 assert.equal((await lan.me()).authenticated,true,'nothing was changed or removed');
});

test('Signing out everywhere ends every session and pending reset link of the account, this one too unless keepCurrent',async t=>{
 const {sqlite,env}=environment(t),lan=browser(env),phone=browser(env,'203.0.113.4'),school=browser(env,'192.0.2.4'),an=browser(env);
 assert.equal((await register(lan)).status,201);assert.equal((await phone.login('lan@example.test',PASSWORD)).status,200);assert.equal((await school.login('lan@example.test',PASSWORD)).status,200);
 assert.equal((await register(an,'an@example.test')).status,201);
 const uid=userId(sqlite,'lan@example.test'),links=()=>sqlite.prepare('SELECT COUNT(*) AS n FROM reader_password_resets WHERE user_id=?').get(uid).n;
 await worker.fetch(new Request(`${origin}/api/users/${uid}/password-reset`,{method:'POST',headers:{Authorization:`Bearer ${ADMIN}`,Origin:origin}}),env,{});assert.equal(links(),1);
 const others=await phone.send('/api/auth/logout-all',{method:'POST',body:{keepCurrent:true}});
 assert.equal(others.status,200);assert.deepEqual(others.json,{ok:true,ended:2,signedOut:false});assert.equal(others.cookies.length,0);
 assert.deepEqual([(await phone.me()).authenticated,(await lan.me()).authenticated,(await school.me()).authenticated],[true,false,false]);assert.equal(links(),0);
 assert.equal((await lan.login('lan@example.test',PASSWORD)).status,200);
 const all=await phone.send('/api/auth/logout-all',{method:'POST'});
 assert.equal(all.status,200);assert.deepEqual(all.json,{ok:true,ended:1,signedOut:true});assert.match(all.cookies[0],/^cat_hien_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Secure$/u);
 assert.deepEqual([(await phone.me()).authenticated,(await lan.me()).authenticated],[false,false]);
 assert.equal((await an.me()).authenticated,true,'other accounts keep their sessions');
 const signedOut=await phone.send('/api/auth/logout-all',{method:'POST'});assert.equal(signedOut.status,401);assert.equal(signedOut.json.code,'signed_out');
 assert.equal((await an.send('/api/auth/logout-all',{method:'POST',headers:{Origin:'https://evil.example'}})).status,403);assert.equal((await an.me()).authenticated,true);
});

test('Changing the password needs the current one, refuses weak or unchanged ones, signs the other devices out and gives this browser a new session',async t=>{
 const {sqlite,env}=environment(t),lan=browser(env),phone=browser(env,'203.0.113.4'),change=(client,body)=>client.send('/api/auth/password',{method:'POST',body});
 assert.equal((await change(browser(env),{currentPassword:PASSWORD,newPassword:'mot-mat-khau-moi-han'})).json.code,'signed_out');
 assert.equal((await register(lan)).status,201);assert.equal((await phone.login('lan@example.test',PASSWORD)).status,200);
 const uid=userId(sqlite,'lan@example.test');
 await worker.fetch(new Request(`${origin}/api/users/${uid}/password-reset`,{method:'POST',headers:{Authorization:`Bearer ${ADMIN}`,Origin:origin}}),env,{});
 for(const [body,status,code] of [[{newPassword:'mot-mat-khau-moi-han'},400,'password_required'],[{currentPassword:'sai-mat-khau',newPassword:'mot-mat-khau-moi-han'},403,'wrong_password'],[{currentPassword:PASSWORD,newPassword:'12345678'},400,'password_pattern'],[{currentPassword:PASSWORD,newPassword:'lan@example.test'},400,'password_like_email'],[{currentPassword:PASSWORD,newPassword:PASSWORD},400,'password_unchanged']]){
  const refused=await change(lan,body);assert.equal(refused.status,status,code);assert.equal(refused.json.code,code);
 }
 assert.equal((await change(lan,{currentPassword:PASSWORD,newPassword:'ngan'})).json.error,'Mật khẩu cần từ 8 đến 128 ký tự.');
 const oldSession=lan.jar.get('cat_hien_session'),done=await change(lan,{currentPassword:PASSWORD,newPassword:'mot-mat-khau-moi-han'});
 assert.equal(done.status,200);assert.deepEqual(done.json,{ok:true,ended:1});
 assert.match(done.cookies[0],/^cat_hien_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/u);assert.match(done.cookies[1],/^cat_hien_device=/u);
 assert.notEqual(lan.jar.get('cat_hien_session'),oldSession,'the session token is new');
 assert.equal((await lan.me()).authenticated,true);assert.equal((await phone.me()).authenticated,false,'the other device is signed out');
 const stale=browser(env);stale.jar.set('cat_hien_session',oldSession);assert.equal((await stale.me()).authenticated,false,'the old session of this browser ended too');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM reader_password_resets WHERE user_id=?').get(uid).n,0,'pending reset links go');
 assert.equal((await browser(env).login('lan@example.test',PASSWORD)).status,401);assert.equal((await browser(env).login('lan@example.test','mot-mat-khau-moi-han')).status,200);
 // A Google-only account has no password to change.
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run('user-minh','google-minh','minh@example.test','Minh');
 sqlite.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await auth.hashToken('minh-session'),'user-minh',Date.now()+3600000);
 const minh=browser(env);minh.jar.set('cat_hien_session','minh-session');
 const google=await change(minh,{currentPassword:'bat-ky',newPassword:'mot-mat-khau-moi-han'});assert.equal(google.status,409);assert.equal(google.json.code,'no_password');
 // Two changes sent at once: one goes through, the other finds itself signed out by it.
 const second=browser(env,'192.0.2.4');assert.equal((await second.login('lan@example.test','mot-mat-khau-moi-han')).status,200);
 const {batch}=env.DB,waiting=[];
 env.DB.batch=async statements=>{if(statements[0].sql.startsWith('UPDATE reader_credentials'))await new Promise(done=>{waiting.push(done);if(waiting.length===2)for(const release of waiting)release();});return batch(statements);};
 const answers=await Promise.all([change(lan,{currentPassword:'mot-mat-khau-moi-han',newPassword:'lan-thu-nhat-doi'}),change(second,{currentPassword:'mot-mat-khau-moi-han',newPassword:'lan-thu-hai-doi'})]);env.DB.batch=batch;
 assert.deepEqual(answers.map(answer=>answer.status).sort(),[200,401]);
 const winner=answers[0].status===200?'lan-thu-nhat-doi':'lan-thu-hai-doi',loser=winner==='lan-thu-nhat-doi'?'lan-thu-hai-doi':'lan-thu-nhat-doi';
 assert.equal((await browser(env).login('lan@example.test',winner)).status,200);assert.equal((await browser(env).login('lan@example.test',loser)).status,401);
});

test('A reset link can be checked without using it up; it is traded only when the page opens it',async t=>{
 const {sqlite,env}=environment(t),lan=browser(env);assert.equal((await register(lan)).status,201);
 const uid=userId(sqlite,'lan@example.test'),issued=await (await worker.fetch(new Request(`${origin}/api/users/${uid}/password-reset`,{method:'POST',headers:{Authorization:`Bearer ${ADMIN}`,Origin:origin}}),env,{})).json();
 const token=new URLSearchParams(issued.resetUrl.split('?')[1]).get('token'),visitor=browser(env,'192.0.2.50'),check=value=>visitor.send('/api/auth/password-reset/check',{method:'POST',body:{token:value}});
 const row=()=>({...sqlite.prepare('SELECT token_hash,used_at,expires_at FROM reader_password_resets WHERE user_id=?').get(uid)});
 const before=row(),checked=await check(token);
 assert.equal(checked.status,200);assert.deepEqual(checked.json,{ok:true,expiresAt:issued.expiresAt});assert.equal(checked.cookies.length,0);
 assert.equal((await check(token)).status,200,'checking twice is fine (a scanner, then the student)');assert.deepEqual(row(),before,'nothing was used up');
 const opened=await visitor.send('/api/auth/password-reset/open',{method:'POST',body:{token}});assert.equal(opened.status,200);
 assert.equal((await check(token)).json.code,'reset_link_invalid','the opened address no longer works');
 const fresh=await check(opened.json.token);assert.equal(fresh.status,200);assert.ok(Date.parse(fresh.json.expiresAt)<=Date.now()+30*60*1000);
 for(const value of [undefined,'',`${token}x`,42])assert.equal((await check(value)).json.code,'reset_link_invalid',String(value));
 sqlite.prepare('UPDATE reader_users SET disabled_at=CURRENT_TIMESTAMP WHERE id=?').run(uid);
 const locked=await check(opened.json.token);assert.equal(locked.status,403);assert.equal(locked.json.code,'account_disabled');
 assert.equal((await visitor.send('/api/auth/password-reset/check',{method:'POST',body:{token},headers:{Origin:'https://evil.example'}})).status,403);
 // Limited as opening a link is, before the link is looked up.
 const keys=[],AUTH_LIMITER={async limit({key}){keys.push(key);return {success:!key.startsWith('password-reset:')};}};
 const limited=await worker.fetch(new Request(origin+'/api/auth/password-reset/check',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'CF-Connecting-IP':'203.0.113.9'},body:JSON.stringify({token})}),{AUTH_LIMITER,DB:{prepare(){throw new Error('The link must not be looked up');}}},{});
 assert.equal(limited.status,429);assert.deepEqual(keys,[`password-reset:${await auth.hashToken(token)}|203.0.113.9`]);
});

test('A Google sign-in that cannot finish goes back to the account page with a code, never to a JSON page',async t=>{
 const {sqlite,env}=environment(t,{GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'}),lines=[];t.mock.method(console,'error',line=>lines.push(line));
 let profile,token=()=>Response.json({access_token:'test-access'}),userinfo=()=>Response.json(profile);
 t.mock.method(globalThis,'fetch',async url=>String(url).startsWith('https://oauth2.googleapis.com/token')?token():userinfo());
 const callback=async(query,{vars={},returnTo='%2Fstudy',state='s-1'}={})=>{
  const response=await worker.fetch(new Request(`${origin}/api/auth/google/callback?${query}`,{headers:{Cookie:`cat_hien_oauth_state=${state}; cat_hien_oauth_return=${returnTo}`}}),{...env,...vars},{});
  assert.equal(response.status,302,query);assert.doesNotMatch(response.headers.get('Content-Type')||'',/json/u);
  const cookies=response.headers.getSetCookie();
  return {location:response.headers.get('Location'),cookies,cleared:['cat_hien_oauth_state','cat_hien_oauth_return'].every(name=>cookies.some(line=>line.startsWith(`${name}=;`)&&/Max-Age=0/u.test(line))),session:cookies.some(line=>line.startsWith('cat_hien_session=')&&!/Max-Age=0/u.test(line))};
 };
 const fails=async(query,code,options)=>{const answer=await callback(query,options);assert.equal(answer.location,`${origin}/#account?loi=${code}&sau=xuong-dich`,query);assert.ok(answer.cleared,query);assert.equal(answer.session,false,query);assert.ok(auth.GOOGLE_FAILURE_CODES?.includes(code),code);};
 profile={sub:'g-1',email:'minh@gmail.com',email_verified:true,name:'Minh'};
 await fails('error=access_denied&state=s-1','google_cancelled');
 assert.equal(lines.length,0,'pressing Cancel is not an error to log');
 await fails('error=server_error&state=s-1','google_error');
 await fails('state=other&code=c','google_state');await fails('code=c','google_state');await fails('state=s-1&code=c','google_state',{state:''});
 token=()=>new Response('{}',{status:400});await fails('state=s-1&code=c','google_failed');
 token=()=>{throw new TypeError('fetch failed');};await fails('state=s-1&code=c','google_failed');
 token=()=>Response.json({access_token:'test-access'});userinfo=()=>new Response('',{status:500});await fails('state=s-1&code=c','google_failed');
 userinfo=()=>Response.json(profile);
 profile={sub:'g-1',email:'minh@gmail.com',email_verified:false};await fails('state=s-1&code=c','google_unverified');
 profile={sub:'g-1',email:`x@${'a'.repeat(320)}.vn`,email_verified:true};await fails('state=s-1&code=c','google_email_invalid');
 profile={sub:'g-1',email:'minh@gmail.com',email_verified:true,name:'Minh'};
 await fails('state=s-1&code=c','registration_closed',{vars:{REGISTRATION_MODE:'closed'}});
 await fails('state=s-1&code=c','registration_domain',{vars:{REGISTRATION_MODE:'domain',ALLOWED_EMAIL_DOMAINS:'truong.edu.vn'}});
 profile={sub:'g-2',email:'an@truong.edu.vn',email_verified:true};await fails('state=s-1&code=c','registration_workspace',{vars:{REGISTRATION_MODE:'domain',ALLOWED_EMAIL_DOMAINS:'truong.edu.vn',REQUIRE_GOOGLE_WORKSPACE:'1'}});
 const {prepare}=env.DB;env.DB.prepare=sql=>{if(sql.startsWith('SELECT id,disabled_at FROM reader_users'))throw new Error('D1_ERROR: storage unavailable');return prepare(sql);};
 await fails('state=s-1&code=c','server_error');env.DB.prepare=prepare;
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM reader_users').get().n,0);
 // Signed in, then locked: the locked account goes back with its code. Where the student was going is kept.
 profile={sub:'g-1',email:'minh@gmail.com',email_verified:true,name:'Minh'};
 const created=await callback('state=s-1&code=c',{returnTo:'%2F%23reader%2Fbook-1%2F2'});assert.equal(created.location,`${origin}/#reader/book-1/2`);assert.ok(created.session);
 sqlite.prepare("UPDATE reader_users SET disabled_at=CURRENT_TIMESTAMP WHERE google_sub='g-1'").run();
 assert.equal((await callback('state=s-1&code=c',{returnTo:'%2F%23reader%2Fbook-1%2F2'})).location,`${origin}/#account?loi=account_disabled&sau=reader/book-1/2`);
 assert.equal((await callback('error=access_denied',{returnTo:'%2F%23yeu-cau'})).location,`${origin}/#account?loi=google_cancelled`,'a waiting request comes back on the account page');
 assert.equal((await callback('state=s-1&code=c',{vars:{GOOGLE_CLIENT_SECRET:''}})).location,`${origin}/#library`,'Google settings removed meanwhile: nothing to finish');
 // What is logged: the code, never the email.
 assert.ok(lines.some(line=>JSON.parse(line).event==='google_sign_in_failed'&&JSON.parse(line).code==='registration_domain'));assert.ok(lines.every(line=>!line.includes('minh@gmail.com')));
 // Starting: without the terms ticked, or without Google set up, the student lands on the account page with the code.
 const start=async(query,vars={})=>(await worker.fetch(new Request(`${origin}/api/auth/google/start${query}`),{...env,...vars},{})).headers.get('Location');
 assert.equal(await start('?return_to=%2Fstudy'),`${origin}/#account?loi=terms_required&sau=xuong-dich`);
 assert.equal(await start('?accept_terms=1',{GOOGLE_CLIENT_ID:''}),`${origin}/#account?loi=google_not_configured`);
 assert.match(await start('?accept_terms=1'),/^https:\/\/accounts\.google\.com\//u);
});

test('A first Google sign-in for an email that signs in with a password makes no second account and says so; nothing is joined',async t=>{
 const {sqlite,env}=environment(t,{GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'}),lines=[];t.mock.method(console,'error',line=>lines.push(line));
 assert.equal((await register(browser(env))).status,201);const lan=userId(sqlite,'lan@example.test'),accounts=()=>sqlite.prepare('SELECT COUNT(*) AS n FROM reader_users').get().n;
 let profile={sub:'g-lan',email:'Lan@Example.test',email_verified:true,name:'Lan (Google)'};
 t.mock.method(globalThis,'fetch',async url=>String(url).startsWith('https://oauth2.googleapis.com/token')?Response.json({access_token:'test-access'}):Response.json(profile));
 const callback=async()=>{const response=await worker.fetch(new Request(`${origin}/api/auth/google/callback?state=s-1&code=c`,{headers:{Cookie:'cat_hien_oauth_state=s-1; cat_hien_oauth_return=%2Fstudy'}}),env,{});return {location:response.headers.get('Location'),session:response.headers.getSetCookie().some(line=>line.startsWith('cat_hien_session=')&&!/Max-Age=0/u.test(line))};};
 assert.deepEqual(await callback(),{location:`${origin}/#account?loi=google_email_has_password&sau=xuong-dich`,session:false});
 assert.ok(auth.GOOGLE_FAILURE_CODES.includes('google_email_has_password'));
 assert.equal(accounts(),1,'no second, empty account');assert.equal(sqlite.prepare('SELECT google_sub FROM reader_users WHERE id=?').get(lan).google_sub,`local:${lan}`,'and the Google account is not joined to it');
 assert.ok(lines.some(line=>JSON.parse(line).code==='google_email_has_password'));assert.ok(lines.every(line=>!/lan@example\.test/iu.test(line)));
 // The password account is locked: the Google sign-in is told so, and still makes nothing.
 sqlite.prepare('UPDATE reader_users SET disabled_at=CURRENT_TIMESTAMP WHERE id=?').run(lan);
 assert.equal((await callback()).location,`${origin}/#account?loi=account_disabled&sau=xuong-dich`);assert.equal(accounts(),1);
 sqlite.prepare('UPDATE reader_users SET disabled_at=NULL WHERE id=?').run(lan);
 // A Google account that signed in before (before this check existed) keeps signing in, whatever its email is now.
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run('user-g-old','g-old','lan@example.test','Lan cũ');
 profile={sub:'g-old',email:'lan@example.test',email_verified:true,name:'Lan cũ'};assert.deepEqual(await callback(),{location:`${origin}/study`,session:true});
 // Another address is a new account as before.
 profile={sub:'g-minh',email:'minh@gmail.com',email_verified:true,name:'Minh'};assert.deepEqual(await callback(),{location:`${origin}/study`,session:true});assert.equal(accounts(),3);
});

test('Registering an email a Google account holds answers 409 email_taken pointing to Google, the same answer as for a password account',async t=>{
 const {sqlite,env}=environment(t,{GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'}),client=browser(env);
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run('user-minh','g-minh','Minh@Gmail.com','Minh');
 assert.equal((await register(client,'lan@example.test')).status,201);
 const held=await register(browser(env,'198.51.100.2'),' MINH@gmail.com ','mot-mat-khau-rieng','Kẻ khác'),taken=await register(browser(env,'198.51.100.3'),'lan@example.test','mot-mat-khau-rieng','Kẻ khác');
 assert.equal(held.status,409);assert.equal(held.json.code,'email_taken');assert.match(held.json.error,/“Tiếp tục bằng Google”/u);
 assert.deepEqual(taken.json,held.json,'which way the account signs in is not told');assert.equal(taken.status,409);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM reader_credentials WHERE email_normalized='minh@gmail.com'").get().n,0,'no password account for the Google address');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM reader_users').get().n,2);
 // Migration 0024: the check finds a Google account's email by index, not by reading every account.
 const asked=[],{prepare}=env.DB;env.DB.prepare=sql=>{asked.push(sql);return prepare(sql);};await register(browser(env,'198.51.100.4'),'minh@gmail.com');env.DB.prepare=prepare;
 const check=asked.find(sql=>sql.includes('lower(email)'));assert.ok(check);
 assert.ok(sqlite.prepare(`EXPLAIN QUERY PLAN ${check}`).all('minh@gmail.com').some(row=>/idx_reader_users_email/u.test(row.detail)));
 // Without Google sign-in the answer is the one it always was; an address no account holds is still free.
 const plain=environment(t);plain.sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run('user-minh','g-minh','minh@gmail.com','Minh');
 assert.deepEqual((await register(browser(plain.env),'minh@gmail.com')).json,{error:'Email này đã có tài khoản.',code:'email_taken'});
 assert.equal((await register(browser(plain.env),'minh2@gmail.com')).status,201);
});

test('A school network can sign up a whole class: 150 accounts a day by default, a refusal that says it is the network\'s and points to Google',async t=>{
 assert.equal(auth.REGISTRATIONS_PER_NETWORK,150);
 const school='203.0.113.5',seed=(sqlite,count)=>sqlite.prepare('INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,?)').run(`register:${school}`,vietnamDay(),count);
 const {sqlite,env}=environment(t,{GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'});seed(sqlite,149);
 assert.equal((await register(browser(env,school),'hs149@example.test')).status,201,'the 150th account of the day');
 const refused=await register(browser(env,school),'hs150@example.test');
 assert.equal(refused.status,429);assert.equal(refused.json.scope,'network');assert.equal(Number(refused.headers.get('Retry-After')),refused.json.retryAfter);
 assert.equal(refused.json.error,'Mạng Internet bạn đang dùng đã tạo đủ 150 tài khoản hôm nay. Đây là hạn mức chung cho cả mạng (ví dụ cả trường dùng chung một mạng), không phải của riêng bạn. Bạn vẫn có thể dùng nút “Tiếp tục bằng Google” ngay bây giờ, hoặc tạo tài khoản sau 0:00 (giờ Việt Nam) hay từ mạng khác như dữ liệu di động.');
 assert.equal((await register(browser(env,'203.0.113.6'),'hs150@example.test')).status,201,'another network is not counted with it');
 // Without Google the refusal does not mention it; DAILY_REGISTRATIONS_PER_IP changes the cap, 0 turns it off.
 const plain=environment(t);seed(plain.sqlite,150);
 assert.doesNotMatch((await register(browser(plain.env,school))).json.error,/Google/u);
 const off=environment(t,{DAILY_REGISTRATIONS_PER_IP:'0'});seed(off.sqlite,5000);assert.equal((await register(browser(off.env,school))).status,201);
 // A form for an email that already has an account uses one registration too, so the answer cannot test more addresses
 // than the cap allows.
 const two=environment(t,{DAILY_REGISTRATIONS_PER_IP:'2'}),client=browser(two.env,school);
 assert.deepEqual([(await register(client,'a@example.test')).status,(await register(client,'a@example.test')).json.code,(await register(client,'b@example.test')).status],[201,'email_taken',429]);
 // The per-minute limit is the loose one, and its answer names the network too.
 const keys=[],API_LIMITER={async limit({key}){keys.push(key);return {success:!key.startsWith('register:')};}},AUTH_LIMITER={async limit({key}){keys.push(key);return {success:true};}};
 const fast=await register(browser({...environment(t).env,API_LIMITER,AUTH_LIMITER},school));
 assert.equal(fast.status,429);assert.deepEqual(fast.json,{error:'Mạng Internet bạn đang dùng vừa tạo nhiều tài khoản trong một phút (giới hạn chung cho cả mạng, không riêng bạn). Hãy đợi khoảng một phút rồi thử lại.',code:'rate_limited',retryAfter:60,scope:'network'});
 assert.deepEqual(keys,[`register:${school}`]);
});

test('A cookie that is not valid percent-encoding reads as absent instead of failing the request',async t=>{
 const {env}=environment(t);
 const response=await worker.fetch(new Request(origin+'/api/me',{headers:{Cookie:'cat_hien_session=%E0%A4%A; other=1'}}),env,{});
 assert.equal(response.status,200);assert.equal((await response.json()).authenticated,false);
});

test('Migration 0022 makes the table the counts use; without it (not applied yet) nothing is blocked and nothing private is logged',async t=>{
 const {sqlite,env}=environment(t);
 assert.deepEqual(sqlite.prepare('PRAGMA table_info(auth_failures)').all().map(({name,type,pk})=>({name,type,pk})),[{name:'key',type:'TEXT',pk:1},{name:'level',type:'REAL',pk:0},{name:'updated_at',type:'INTEGER',pk:0},{name:'locked_until',type:'INTEGER',pk:0}]);
 assert.ok(sqlite.prepare('PRAGMA index_list(auth_failures)').all().some(index=>index.name==='idx_auth_failures_updated'));
 assert.equal((await register(browser(env))).status,201);sqlite.exec('DROP TABLE auth_failures');
 const lines=[];t.mock.method(console,'error',line=>lines.push(line));
 const client=browser(env,'203.0.113.8'),statuses=[];for(let i=0;i<12;i++)statuses.push((await client.login('lan@example.test','doan-sai')).status);
 assert.deepEqual(statuses,Array(12).fill(401));assert.equal((await client.login('lan@example.test',PASSWORD)).status,200);
 assert.ok(lines.length>0&&lines.every(line=>JSON.parse(line).event==='auth_failure_error'));assert.ok(lines.every(line=>!line.includes('lan@example.test')&&!line.includes('203.0.113.8')));
});

test('With real, spread-out timing the 10th wrong password locks for a minute, at login and for the current password of a password change or an account deletion',async t=>{
 // The real clock: every guess costs a PBKDF2, so by the 10th the count has drained a little below 10.
 {
  const {env}=environment(t),lan=browser(env),attacker=browser(env,'203.0.113.66');assert.equal((await register(lan)).status,201);
  for(let i=0;i<10;i++)assert.equal((await attacker.login('lan@example.test',`doan-sai-${i}`)).status,401);
  const locked=await attacker.login('lan@example.test',PASSWORD);
  assert.equal(locked.status,429,'locked after the 10th');assert.equal(locked.headers.get('Retry-After'),'60');assert.equal(locked.json.scope,'failures');
  for(let i=0;i<10;i++)assert.equal((await lan.send('/api/auth/password',{method:'POST',body:{currentPassword:`doan-${i}`,newPassword:'mot-mat-khau-moi-han'}})).status,403);
  const change=await lan.send('/api/auth/password',{method:'POST',body:{currentPassword:PASSWORD,newPassword:'mot-mat-khau-moi-han'}});
  assert.equal(change.status,429,'a password change too');assert.equal(change.headers.get('Retry-After'),'60');
 }
 {
  const {env}=environment(t),an=browser(env);assert.equal((await register(an,'an@example.test')).status,201);
  for(let i=0;i<10;i++)assert.equal((await an.send('/api/me',{method:'DELETE',body:{confirm:'XÓA',password:`doan-${i}`}})).status,403);
  const deletion=await an.send('/api/me',{method:'DELETE',body:{confirm:'XÓA',password:PASSWORD}});
  assert.equal(deletion.status,429,'an account deletion too');assert.equal(deletion.headers.get('Retry-After'),'60');assert.equal((await an.me()).authenticated,true);
 }
 // Guesses 40 seconds apart, ten in six minutes: nine never lock; the 10th does, for a minute, and then it is over.
 const {env}=environment(t),tick=clock(t),lan=browser(env),attacker=browser(env,'203.0.113.66'),typist=browser(env,'198.51.100.77');
 assert.equal((await register(lan)).status,201);
 for(let i=0;i<9;i++){if(i)tick(40000);assert.equal((await typist.login('lan@example.test','go-nham-roi')).status,401);}
 tick(40000);assert.equal((await typist.login('lan@example.test',PASSWORD)).status,200,'nine wrong passwords do not lock');
 for(let i=0;i<10;i++){if(i)tick(40000);assert.equal((await attacker.login('lan@example.test',`doan-sai-${i}`)).status,401);}
 const locked=await attacker.login('lan@example.test',PASSWORD);assert.equal(locked.status,429);assert.equal(locked.headers.get('Retry-After'),'60');
 tick(61000);assert.equal((await attacker.login('lan@example.test',PASSWORD)).status,200,'a minute later the right password signs in');
});

test('A reset link lifts what locked the account: its counts are cleared and the browser gets a device mark, as a password change gives one',async t=>{
 const {sqlite,env}=environment(t);clock(t);const lan=browser(env);assert.equal((await register(lan)).status,201);
 const uid=userId(sqlite,'lan@example.test');
 // Wrong passwords from fifty networks lock the address for every browser without a mark: here Lan's, after she
 // cleared its cookies, with the right password.
 for(let i=0;i<50;i++)assert.equal((await browser(env,`203.0.113.${i+1}`).login('lan@example.test','doan-sai')).status,401);
 const home=browser(env,'198.51.100.5');assert.equal((await home.login('lan@example.test',PASSWORD)).status,429);
 const issued=await (await worker.fetch(new Request(`${origin}/api/users/${uid}/password-reset`,{method:'POST',headers:{Authorization:`Bearer ${ADMIN}`,Origin:origin}}),env,{})).json();
 const opened=await home.send('/api/auth/password-reset/open',{method:'POST',body:{token:new URLSearchParams(issued.resetUrl.split('?')[1]).get('token')}});
 const reset=await home.send('/api/auth/password-reset',{method:'POST',body:{token:opened.json.token,password:'tre-xanh-mua-ha'}});
 assert.equal(reset.status,200);assert.deepEqual(reset.json,{ok:true});
 assert.match(reset.cookies[0],/^cat_hien_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/u);
 assert.match(reset.cookies[1],/^cat_hien_device=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}; Path=\/api\/auth\/; HttpOnly; SameSite=Strict; Max-Age=31536000; Secure$/u);
 assert.equal(await failureLevel(sqlite,'login-email:lan@example.test'),0,'the count of the address is cleared');
 assert.equal(await failureLevel(sqlite,'login-network:203.0.113.1'),1,'a network\'s count is not the account\'s to clear');
 // The guesses go on: a browser without the mark waits again, hers signs in with the new password.
 for(let i=0;i<50;i++)assert.equal((await browser(env,`192.0.2.${i+1}`).login('lan@example.test','doan-tiep')).status,401);
 assert.equal((await browser(env,'192.0.2.200').login('lan@example.test','tre-xanh-mua-ha')).status,429);
 assert.equal((await home.send('/api/auth/logout',{method:'POST'})).status,204);
 assert.equal((await home.login('lan@example.test','tre-xanh-mua-ha')).status,200,'her browser has the mark of the new password');
});

test('Counts are removed about a day after the last wrong password, even when no new count starts',async t=>{
 const {sqlite,env}=environment(t),tick=clock(t),lan=browser(env),phone=browser(env,'203.0.113.10');
 assert.equal((await register(lan)).status,201);
 const rows=()=>sqlite.prepare('SELECT COUNT(*) AS n FROM auth_failures').get().n,day=24*60*60*1000;
 // A typo, then the right password: the count of the address on that network is cleared, the address's and the network's stay.
 assert.equal((await phone.login('lan@example.test','go-nham-roi')).status,401);assert.equal((await phone.login('lan@example.test',PASSWORD)).status,200);assert.equal(rows(),2);
 tick(day-60000);assert.equal((await lan.login('lan@example.test',PASSWORD)).status,200);assert.equal(rows(),2,'kept for a day');
 tick(2*60000);assert.equal((await lan.login('lan@example.test',PASSWORD)).status,200);assert.equal(rows(),0,'gone with the next sign-in');
 // On a quiet day the rows go when a page asks who is signed in.
 assert.equal((await browser(env,'203.0.113.11').login('lan@example.test','go-nham-roi')).status,401);assert.equal(rows(),3);
 tick(day+60000);assert.equal((await browser(env).me()).authenticated,false);assert.equal(rows(),0);
});

test('Counts are keyed by an HMAC only the server can make: no address or email can be recovered or confirmed from the table',async t=>{
 const {sqlite,env}=environment(t);assert.equal((await register(browser(env))).status,201);
 assert.equal((await browser(env,'198.51.100.77').login('lan@example.test','doan-sai')).status,401);
 const names=['login:lan@example.test|198.51.100.77','login-network:198.51.100.77','login-email:lan@example.test'];
 const keys=sqlite.prepare('SELECT key FROM auth_failures').all().map(row=>row.key).sort();
 for(const name of names)assert.ok(!keys.includes(await auth.hashToken(`auth-failure:${name}`)),`${name}: not a plain SHA-256 anyone can recompute`);
 assert.deepEqual(keys,(await Promise.all(names.map(name=>auth.failureKey(env,name)))).sort(),'the server finds them again');
 assert.ok(!keys.includes(await auth.failureKey({ADMIN_TOKEN:'b9'.repeat(32)},names[1])),'another server secret gives other keys');
});

test('Counts of a day ago are cleared when a new count starts',async t=>{
 const {sqlite,env}=environment(t),tick=clock(t);assert.equal((await register(browser(env))).status,201);
 assert.equal((await browser(env,'203.0.113.10').login('lan@example.test','doan-sai')).status,401);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM auth_failures').get().n,3,'per email and network, per network, per email');
 tick(25*60*60*1000);assert.equal((await browser(env,'203.0.113.11').login('khac@example.test','doan-sai')).status,401);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM auth_failures').get().n,3,'only the new counts are left');
 assert.equal(await failureLevel(sqlite,'login-email:lan@example.test'),0);
});
