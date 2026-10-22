import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import worker from './worker.js';
import {hashToken} from './reader-auth.js';
import {deleteAccount} from './account.js';

// Password reset links: an admin creates one (POST /api/users/:id/password-reset), the student sets a new password with
// it (POST /api/auth/password-reset). Real SQLite with every migration, called through worker.fetch as the admin page and
// the browser call it; no e-mail is sent and nothing leaves the machine.
const origin='https://hoa-tri.example',ADMIN='e7'.repeat(32),OLD='mat-khau-cu-cua-lan',NEW='mat-khau-moi-cua-lan',DAY=24*60*60*1000;
const INVALID={error:'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Hãy xin quản trị viên một liên kết mới.',code:'reset_link_invalid'};
const LOCKED={error:'Tài khoản này đang bị tạm khóa. Hãy liên hệ quản trị viên.',code:'account_disabled'};
const WEAK={error:'Mật khẩu cần từ 8 đến 128 ký tự.'};
class D1Statement{
 constructor(database,sql){this.sql=sql;this.statement=database.prepare(sql);this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){return this.statement.get(...this.args)||null;}
 async all(){return {results:this.statement.all(...this.args),success:true};}
 execute(){const result=this.statement.run(...this.args);return {success:true,meta:{changes:result.changes}};}
 async run(){return this.execute();}
}
const migrations=fileURLToPath(new URL('../database/migrations/',import.meta.url));
// Lan and An register through the API (real PBKDF2 hashes); Minh signs in with Google only. Every answer is kept in
// `seen`, to check what a response ever carried.
async function environment(t,{foreignKeys=true,vars={}}={}){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec(`PRAGMA foreign_keys=${foreignKeys?'ON':'OFF'}`);
 for(const name of readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../database/migrations/'+name,import.meta.url),'utf8'));
 const DB={prepare:sql=>new D1Statement(sqlite,sql),async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 const env={DB,ADMIN_TOKEN:ADMIN,...vars},seen=[];
 const send=async(path,{method='GET',body,headers={}}={})=>{
  const init={method,headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers}};if(body!==undefined)init.body=typeof body==='string'?body:JSON.stringify(body);
  const response=await worker.fetch(new Request(origin+path,init),env,{}),text=await response.text();
  seen.push({status:response.status,text,headers:[...response.headers].map(pair=>pair.join(': ')).join('\n')});
  let json=null;try{json=JSON.parse(text);}catch{}
  return {status:response.status,headers:response.headers,json,cookie:response.headers.getSetCookie().find(line=>line.startsWith('cat_hien_session='))?.split(';')[0]};
 };
 const register=async(name,email)=>{const response=await send('/api/auth/register',{method:'POST',body:{name,email,password:OLD,acceptTerms:true}});assert.equal(response.status,201);return {id:sqlite.prepare('SELECT user_id FROM reader_credentials WHERE email_normalized=?').get(email).user_id,cookie:response.cookie};};
 const lan=await register('Lan','lan@example.test'),an=await register('An','an@example.test');
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run('user-minh','google-minh','minh@example.test','Minh');
 sqlite.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await hashToken('minh-session'),'user-minh',Date.now()+3600000);
 const issue=(id,token=ADMIN,method='POST')=>send(`/api/users/${id}/password-reset`,{method,headers:token?{Authorization:`Bearer ${token}`}:{}});
 const reset=(token,password,headers)=>send('/api/auth/password-reset',{method:'POST',body:{token,password},headers});
 const login=(email,password)=>send('/api/auth/login',{method:'POST',body:{email,password}});
 const me=async cookie=>(await send('/api/me',{headers:{Cookie:cookie}})).json;
 const links=id=>sqlite.prepare('SELECT * FROM reader_password_resets WHERE user_id=?').all(id);
 const sessions=id=>sqlite.prepare('SELECT token_hash FROM reader_sessions WHERE user_id=? ORDER BY token_hash').all(id).map(row=>row.token_hash);
 const passwordHash=id=>sqlite.prepare('SELECT password_hash FROM reader_credentials WHERE user_id=?').get(id).password_hash;
 return {sqlite,env,seen,send,lan,an,issue,reset,login,me,links,sessions,passwordHash};
}
const tokenOf=response=>new URLSearchParams(response.json.resetUrl.split('?')[1]).get('token');
const randomLink=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
// Holds the reset batches until `count` of them arrive (each request has checked its link and hashed its password by
// then), runs `meanwhile`, then lets them write one after the other.
function holdResets(env,count,meanwhile=()=>{}){
 const {batch}=env.DB,waiting=[];
 env.DB.batch=async statements=>{if(statements[0].sql.startsWith('INSERT INTO reader_sessions'))await new Promise(done=>{waiting.push(done);if(waiting.length===count){meanwhile();for(const release of waiting)release();}});return batch(statements);};
 return ()=>{env.DB.batch=batch;};
}

test('A link from an admin lets the student set a new password once: signed in, other sessions ended, old password gone',async t=>{
 const {sqlite,seen,send,lan,an,issue,reset,login,me,links,sessions,passwordHash}=await environment(t);
 const second=await login('lan@example.test',OLD);assert.equal(second.status,200);assert.equal(sessions(lan.id).length,2,'signed in on two devices');
 const before=Date.now(),created=await issue(lan.id);
 assert.equal(created.status,201);assert.deepEqual(Object.keys(created.json).sort(),['expiresAt','resetUrl']);assert.equal(created.headers.get('Cache-Control'),'no-store');
 assert.match(created.json.resetUrl,/^\/#dat-lai-mat-khau\?token=[A-Za-z0-9_-]{43}$/u);
 assert.match(created.json.expiresAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u);const expires=Date.parse(created.json.expiresAt);assert.ok(expires>=before+DAY&&expires<=Date.now()+DAY,'valid for 24 hours');
 // Only the SHA-256 of the token is stored.
 const token=tokenOf(created),hash=await hashToken(token),[row]=links(lan.id);
 assert.equal(row.token_hash,hash);assert.equal(row.expires_at,expires);assert.equal(row.used_at,null);assert.match(row.created_at,/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/u);
 assert.ok(!JSON.stringify(sqlite.prepare('SELECT * FROM reader_password_resets').all()).includes(token));
 const done=await reset(token,NEW);
 assert.equal(done.status,200);assert.deepEqual(done.json,{ok:true});
 assert.match(done.headers.get('Set-Cookie'),/^cat_hien_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/u);
 assert.deepEqual(sessions(lan.id),[await hashToken(done.cookie.split('=')[1])],'the new session is the only one left');
 assert.equal((await me(done.cookie)).user.id,lan.id);
 for(const cookie of [lan.cookie,second.cookie])assert.equal((await me(cookie)).authenticated,false,'whoever knew the old password is signed out');
 assert.equal(sessions('user-minh').length,1,'other accounts keep their sessions');assert.equal(sessions(an.id).length,1);
 assert.match(passwordHash(lan.id),/^pbkdf2-sha256\$100000\$[A-Za-z0-9+/]{43}=$/u);
 assert.equal((await login('lan@example.test',OLD)).status,401);assert.equal((await login('lan@example.test',NEW)).status,200);assert.equal((await login('an@example.test',OLD)).status,200,'An keeps her password');
 // The link works once.
 const count=sessions(lan.id).length,again=await reset(token,'mat-khau-thu-ba');
 assert.equal(again.status,400);assert.deepEqual(again.json,INVALID);assert.equal(again.cookie,undefined);assert.equal(sessions(lan.id).length,count);
 assert.equal((await login('lan@example.test','mat-khau-thu-ba')).status,401);assert.equal(typeof links(lan.id)[0].used_at,'number');
 // What the responses carried, the admin's account list included: the token only in the answer that created it, its
 // hash never.
 assert.equal((await send('/api/users',{headers:{Authorization:`Bearer ${ADMIN}`}})).status,200);
 assert.deepEqual(seen.filter(item=>item.text.includes(token)||item.headers.includes(token)).map(item=>item.status),[201]);
 assert.equal(seen.some(item=>item.text.includes(hash)||item.headers.includes(hash)),false);
});

test('Expired, unknown and malformed links are refused with one message, and nothing changes',async t=>{
 const {sqlite,send,lan,issue,reset,login,links,sessions}=await environment(t);
 const token=tokenOf(await issue(lan.id));sqlite.prepare('UPDATE reader_password_resets SET expires_at=? WHERE user_id=?').run(Date.now()-1,lan.id);
 const expired=await reset(token,NEW);assert.equal(expired.status,400);assert.deepEqual(expired.json,INVALID);assert.equal(expired.cookie,undefined);
 assert.equal(links(lan.id)[0].used_at,null);assert.equal(sessions(lan.id).length,1);assert.equal((await login('lan@example.test',OLD)).status,200,'the password is unchanged');
 for(const value of [randomLink(),undefined,'',token.slice(1),`${token}=`,`${token}x`,`${token.slice(1)}+`,42,[token],{token}]){const refused=await reset(value,NEW);assert.equal(refused.status,400,String(value));assert.deepEqual(refused.json,INVALID,String(value));}
 // Not JSON at all, or sent from another site.
 const garbled=await send('/api/auth/password-reset',{method:'POST',body:'{"token":'});assert.equal(garbled.status,400);assert.equal(garbled.json.code,'invalid_body');
 const foreign=await reset(token,NEW,{Origin:'https://evil.example'});assert.equal(foreign.status,403);assert.equal(foreign.json.code,'origin');
});

test('A weak password gets the registration message and leaves the link usable',async t=>{
 const {send,lan,issue,reset,links}=await environment(t),token=tokenOf(await issue(lan.id));
 const registration=await send('/api/auth/register',{method:'POST',body:{name:'Bình',email:'binh@example.test',password:'ngan',acceptTerms:true}});
 assert.equal(registration.status,400);assert.deepEqual(registration.json,WEAK);
 for(const password of [undefined,'','ngan','1234567','x'.repeat(129)]){const weak=await reset(token,password);assert.equal(weak.status,400,String(password));assert.deepEqual(weak.json,WEAK,String(password));assert.equal(weak.cookie,undefined);}
 assert.equal(links(lan.id)[0].used_at,null,'the link still works');
 // A password people pick most often is refused as at registration, and the link still works.
 const common=await reset(token,'12345678');assert.equal(common.status,400);assert.equal(common.json.code,'password_pattern');assert.equal(common.cookie,undefined);
 assert.equal(links(lan.id)[0].used_at,null);
 assert.equal((await reset(token,'tre-xanh')).status,200,'8 characters are enough, as at registration');
});

test('Only an admin creates links; an unknown account gets 404, a Google-only or locked one 409',async t=>{
 const {sqlite,send,lan,an,issue,reset,links}=await environment(t),count=()=>sqlite.prepare('SELECT COUNT(*) AS n FROM reader_password_resets').get().n;
 for(const token of [null,'x'.repeat(64),ADMIN.slice(1)]){const refused=await issue(lan.id,token);assert.equal(refused.status,401);assert.deepEqual(refused.json,{error:'Hãy mở Cài đặt và nhập mã quản trị để tiếp tục.'});}
 assert.equal((await send(`/api/users/${lan.id}/password-reset`,{method:'POST',headers:{Cookie:lan.cookie}})).status,401,'a signed-in student is not an admin');
 assert.equal((await send(`/api/users/${lan.id}/password-reset`,{method:'POST',headers:{Authorization:`Bearer ${ADMIN}`,Origin:'https://evil.example'}})).status,403);
 assert.equal(count(),0);
 const missing=await issue('no-such-user');assert.equal(missing.status,404);assert.deepEqual(missing.json,{error:'Không tìm thấy tài khoản.'});
 const google=await issue('user-minh');assert.equal(google.status,409);assert.deepEqual(google.json,{error:'Tài khoản này đăng nhập bằng Google nên không có mật khẩu để đặt lại.',code:'no_password'});
 // A link signs the student in, which a lock refuses as login does: the admin is told to unlock first.
 const lock=disabled=>send(`/api/users/${lan.id}`,{method:'PATCH',body:{disabled},headers:{Authorization:`Bearer ${ADMIN}`}});
 assert.equal((await lock(true)).status,200);
 const locked=await issue(lan.id);assert.equal(locked.status,409);assert.deepEqual(locked.json,{error:'Tài khoản này đang bị tạm khóa. Hãy mở khóa trước khi tạo liên kết đặt lại mật khẩu.',code:'account_disabled'});
 assert.equal(count(),0);
 for(const method of ['GET','PUT','DELETE'])assert.equal((await issue(lan.id,ADMIN,method)).status,405,method);
 assert.equal((await lock(false)).status,200);assert.equal((await issue(lan.id)).status,201,'unlocked, the account gets a link');
 // An account whose deletion has started is gone already: no new link, and its link no longer works.
 const anToken=tokenOf(await issue(an.id));sqlite.prepare('UPDATE reader_users SET deleting_at=CURRENT_TIMESTAMP WHERE id=?').run(an.id);
 assert.equal((await issue(an.id)).status,404);assert.deepEqual((await reset(anToken,NEW)).json,INVALID);assert.equal(links(an.id).length,0,'its older link was replaced');
});

test('A new link replaces the older one, and links past their time are cleared',async t=>{
 const {sqlite,lan,an,issue,reset,links}=await environment(t);
 const first=tokenOf(await issue(lan.id)),second=tokenOf(await issue(lan.id)),anToken=tokenOf(await issue(an.id));assert.notEqual(first,second);
 assert.deepEqual(links(lan.id).map(row=>row.token_hash),[await hashToken(second)]);
 // An expired link of An's is cleared when any new link is made; her valid one stays.
 sqlite.prepare('INSERT INTO reader_password_resets(token_hash,user_id,expires_at) VALUES(?,?,?)').run('f'.repeat(64),an.id,Date.now()-1);
 const third=tokenOf(await issue(lan.id));
 assert.deepEqual(links(lan.id).map(row=>row.token_hash),[await hashToken(third)]);assert.deepEqual(links(an.id).map(row=>row.token_hash),[await hashToken(anToken)]);
 for(const old of [first,second])assert.deepEqual((await reset(old,NEW)).json,INVALID,'an older link no longer works');
 assert.equal((await reset(third,NEW)).status,200);assert.equal((await reset(anToken,NEW)).status,200);
});

test('Locking removes pending links; a link whose account is locked is refused as login refuses it, and works once unlocked',async t=>{
 const {sqlite,send,lan,issue,reset,login,links,sessions,passwordHash}=await environment(t);
 const lock=disabled=>send(`/api/users/${lan.id}`,{method:'PATCH',body:{disabled},headers:{Authorization:`Bearer ${ADMIN}`}});
 const before=tokenOf(await issue(lan.id));assert.deepEqual((await lock(true)).json,{ok:true,disabled:true});
 assert.deepEqual(links(lan.id),[],'locking removes the link with the sessions');assert.deepEqual(sessions(lan.id),[]);
 await lock(false);assert.deepEqual((await reset(before,NEW)).json,INVALID,'unlocking does not bring it back');
 // A lock that kept a link (set by hand, or lands while the link is in use, see below): the student holding the link
 // is told the account is locked, as login says after the right password, and nothing changes.
 const token=tokenOf(await issue(lan.id)),hash=passwordHash(lan.id);sqlite.prepare('UPDATE reader_users SET disabled_at=CURRENT_TIMESTAMP WHERE id=?').run(lan.id);
 for(const password of [NEW,'ngan']){const refused=await reset(token,password);assert.equal(refused.status,403);assert.deepEqual(refused.json,LOCKED);assert.equal(refused.cookie,undefined);}
 assert.deepEqual((await login('lan@example.test',OLD)).json,LOCKED,'login says the same');
 assert.deepEqual((await reset(randomLink(),NEW)).json,INVALID,'a wrong link says nothing about the lock');
 assert.equal(links(lan.id)[0].used_at,null);assert.equal(passwordHash(lan.id),hash);
 sqlite.prepare('UPDATE reader_users SET disabled_at=NULL WHERE id=?').run(lan.id);
 assert.equal((await reset(token,NEW)).status,200,'unlocked, the same link works');assert.equal((await login('lan@example.test',NEW)).status,200);
});

test('A link sent twice at once changes the password once, and a lock landing meanwhile changes nothing',async t=>{
 const {sqlite,env,lan,issue,reset,login,links,sessions,passwordHash}=await environment(t);
 const token=tokenOf(await issue(lan.id)),release=holdResets(env,2);
 const answers=await Promise.all([reset(token,'mat-khau-thu-nhat'),reset(token,'mat-khau-thu-hai')]);release();
 assert.deepEqual(answers.map(answer=>answer.status).sort(),[200,400]);assert.deepEqual(answers.find(answer=>answer.status===400).json,INVALID);
 const [winner,loser]=answers[0].status===200?['mat-khau-thu-nhat','mat-khau-thu-hai']:['mat-khau-thu-hai','mat-khau-thu-nhat'];
 assert.equal(sessions(lan.id).length,1,'one new session; the other request made none');
 assert.equal((await login('lan@example.test',loser)).status,401);assert.equal((await login('lan@example.test',winner)).status,200);
 // The account is locked after the link was checked, before the password is written.
 const next=tokenOf(await issue(lan.id)),hash=passwordHash(lan.id),open=sessions(lan.id);
 const again=holdResets(env,1,()=>sqlite.prepare('UPDATE reader_users SET disabled_at=CURRENT_TIMESTAMP WHERE id=?').run(lan.id));
 const locked=await reset(next,'mat-khau-thu-ba');again();
 assert.equal(locked.status,403);assert.deepEqual(locked.json,LOCKED);assert.equal(locked.cookie,undefined);
 assert.equal(passwordHash(lan.id),hash);assert.deepEqual(sessions(lan.id),open);assert.equal(links(lan.id)[0].used_at,null);
});

test('Deleting an account removes its links, with the explicit statement as well as the foreign key',async t=>{
 const {sqlite,send,lan,an,issue,reset}=await environment(t),count=()=>sqlite.prepare('SELECT COUNT(*) AS n FROM reader_password_resets').get().n;
 const lanToken=tokenOf(await issue(lan.id)),anToken=tokenOf(await issue(an.id));assert.equal(count(),2);
 assert.deepEqual((await send(`/api/users/${lan.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${ADMIN}`}})).json,{ok:true},'by an admin');
 assert.equal(count(),1);assert.deepEqual((await reset(lanToken,NEW)).json,INVALID);
 assert.equal((await send('/api/me',{method:'DELETE',body:{confirm:'XÓA',password:OLD},headers:{Cookie:an.cookie}})).status,204,'by the student');
 assert.equal(count(),0);assert.deepEqual((await reset(anToken,NEW)).json,INVALID);assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_list(reader_password_resets)').all().map(({table,from,to,on_delete})=>({table,from,to,on_delete})),[{table:'reader_users',from:'user_id',to:'id',on_delete:'CASCADE'}]);
 assert.ok(sqlite.prepare('PRAGMA index_list(reader_password_resets)').all().some(index=>index.name==='idx_reader_password_resets_user'));
 // deleteAccount removes the rows child first, as it does every table, so the result does not depend on the cascade.
 const loose=await environment(t,{foreignKeys:false});await loose.issue(loose.lan.id);
 assert.equal(await deleteAccount(loose.env,loose.lan.id),'deleted');assert.equal(loose.sqlite.prepare('SELECT COUNT(*) AS n FROM reader_password_resets').get().n,0);
});

// A rate-limit binding that refuses keys starting with one of `blocked` and records every key it was asked about, and
// one that counts as the Workers binding does: at most `max` uses per key (one minute, one location).
function limiter(blocked=[]){const keys=[];return {keys,async limit({key}){keys.push(key);return {success:!blocked.some(prefix=>key.startsWith(prefix))};}};}
function countingLimiter(max){const counts=new Map();return {counts,async limit({key}){const count=(counts.get(key)||0)+1;counts.set(key,count);return {success:count<=max};}};}

test('Resets are rate limited as login is, before the link is looked up, without stopping a class behind one address',async t=>{
 const token=randomLink(),AUTH_LIMITER=limiter(['password-reset:']),API_LIMITER=limiter();
 const response=await worker.fetch(new Request(origin+'/api/auth/password-reset',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'CF-Connecting-IP':'203.0.113.9'},body:JSON.stringify({token,password:NEW})}),{AUTH_LIMITER,API_LIMITER,DB:{prepare(){throw new Error('The link must not be looked up');}}},{});
 assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'60');
 assert.deepEqual(await response.json(),{error:'Bạn thao tác quá nhanh. Hãy đợi khoảng một phút rồi thử lại.',code:'rate_limited',retryAfter:60});
 // The keys carry the link's hash, never the link.
 assert.deepEqual(API_LIMITER.keys,['password-reset-ip:203.0.113.9']);assert.deepEqual(AUTH_LIMITER.keys,[`password-reset:${await hashToken(token)}|203.0.113.9`]);
 const {lan,an,issue,reset}=await environment(t,{vars:{AUTH_LIMITER:countingLimiter(10),API_LIMITER:countingLimiter(30)}});
 const lanToken=tokenOf(await issue(lan.id)),anToken=tokenOf(await issue(an.id)),school={'CF-Connecting-IP':'198.51.100.7'};
 const tries=[];for(let i=0;i<11;i++)tries.push((await reset(lanToken,'ngan',school)).status);
 assert.deepEqual(tries,[...Array(10).fill(400),429],'one link tried again and again from one network stops after 10 a minute');
 assert.equal((await reset(anToken,NEW,school)).status,200,'another link handed to the same class still works');
 assert.equal((await reset(lanToken,NEW,{'CF-Connecting-IP':'192.0.2.1'})).status,200);
 // Unknown links from one network meet the looser count per network.
 const flood=[];for(let i=0;i<31;i++)flood.push((await reset(randomLink(),NEW,{'CF-Connecting-IP':'203.0.113.50'})).status);
 assert.deepEqual(flood,[...Array(30).fill(400),429]);
});

test('Opening a link trades its token for a fresh one: the opened address (kept in the browser history) stops working',async t=>{
 const {sqlite,send,lan,an,issue,reset,login,links}=await environment(t);
 const open=(token,headers)=>send('/api/auth/password-reset/open',{method:'POST',body:{token},headers});
 const token=tokenOf(await issue(lan.id)),before=Date.now(),opened=await open(token),fresh=opened.json.token;
 assert.equal(opened.status,200);assert.deepEqual(Object.keys(opened.json),['token']);assert.match(fresh,/^[A-Za-z0-9_-]{43}$/u);assert.notEqual(fresh,token);
 assert.equal(opened.headers.get('Cache-Control'),'no-store');assert.equal(opened.cookie,undefined,'opening signs nobody in');
 const [row]=links(lan.id);assert.equal(row.token_hash,await hashToken(fresh));assert.equal(row.used_at,null);
 assert.ok(row.expires_at>=before+30*60*1000&&row.expires_at<=Date.now()+30*60*1000,'good for 30 minutes');
 // The opened address is refused for opening again and for setting a password; nothing changes.
 assert.deepEqual((await open(token)).json,INVALID);assert.deepEqual((await reset(token,NEW)).json,INVALID);
 assert.equal((await login('lan@example.test',OLD)).status,200);
 // The fresh token sets the password once, and then cannot be opened either.
 assert.equal((await reset(fresh,NEW)).status,200);assert.equal((await login('lan@example.test',NEW)).status,200);
 assert.deepEqual((await open(fresh)).json,INVALID);
 // Never past the link's own expiry.
 const late=tokenOf(await issue(lan.id)),end=Date.now()+60_000;sqlite.prepare('UPDATE reader_password_resets SET expires_at=? WHERE user_id=?').run(end,lan.id);
 assert.equal((await open(late)).status,200);assert.equal(links(lan.id)[0].expires_at,end);
 // Two opens sent at once: one gets a token.
 const twice=tokenOf(await issue(lan.id)),both=await Promise.all([open(twice),open(twice)]);
 assert.deepEqual(both.map(response=>response.status).sort(),[200,400]);
 // A locked account, malformed tokens and another site are refused as by the reset itself.
 const locked=tokenOf(await issue(an.id));sqlite.prepare('UPDATE reader_users SET disabled_at=CURRENT_TIMESTAMP WHERE id=?').run(an.id);
 const refused=await open(locked);assert.equal(refused.status,403);assert.deepEqual(refused.json,LOCKED);
 for(const value of [randomLink(),undefined,'',`${late}x`,42])assert.deepEqual((await open(value)).json,INVALID,String(value));
 assert.equal((await open(locked,{Origin:'https://evil.example'})).status,403);
});
