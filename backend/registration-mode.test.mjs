import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import worker from './worker.js';
import {TERMS_VERSION,registrationPolicy,registrationRefusal} from './reader-auth.js';

const origin='https://hoa-tri.example',ADMIN='c0'.repeat(32);
class D1Statement{
 constructor(database,sql){this.statement=database.prepare(sql);this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){return this.statement.get(...this.args)||null;}
 async all(){return {results:this.statement.all(...this.args),success:true};}
 execute(){const result=this.statement.run(...this.args);return {success:true,meta:{changes:result.changes}};}
 async run(){return this.execute();}
}
function environment(t,vars={}){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 for(const name of readdirSync(fileURLToPath(new URL('../database/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../database/migrations/'+name,import.meta.url),'utf8'));
 const DB={prepare:sql=>new D1Statement(sqlite,sql),async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 return {sqlite,env:{DB,ADMIN_TOKEN:ADMIN,...vars}};
}
const post=(env,path,body,headers={})=>worker.fetch(new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...headers},body:JSON.stringify(body)}),env,{});
const account=(email,extra={})=>({name:'Lan',email,password:'mat-khau-dai',acceptTerms:true,...extra});
const sessionCookie=response=>response.headers.getSetCookie().find(line=>line.startsWith('cat_hien_session='))?.split(';')[0];
const me=async(env,cookie)=>(await worker.fetch(new Request(origin+'/api/me',{headers:cookie?{Cookie:cookie}:{}}),env,{})).json();

test('Registration requires accepting the terms and records which version was accepted',async t=>{
 const {sqlite,env}=environment(t);
 const refused=await post(env,'/api/auth/register',account('lan@example.test',{acceptTerms:undefined}));
 assert.equal(refused.status,400);assert.deepEqual(await refused.json(),{error:'Hãy đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư để tạo tài khoản.',code:'terms_required'});
 assert.equal((await post(env,'/api/auth/register',account('lan@example.test',{acceptTerms:'true'}))).status,400,'only a real true counts');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM reader_users').get().count,0);
 const created=await post(env,'/api/auth/register',account('lan@example.test'));assert.equal(created.status,201);
 const user=sqlite.prepare('SELECT terms_version,terms_accepted_at,disabled_at FROM reader_users').get();
 assert.equal(user.terms_version,TERMS_VERSION);assert.match(user.terms_accepted_at,/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/u);assert.equal(user.disabled_at,null);
 const profile=await me(env,sessionCookie(created));assert.equal(profile.authenticated,true);assert.equal(profile.user.provider,'local');assert.equal(profile.termsVersion,TERMS_VERSION);
 assert.deepEqual(profile.registration,{mode:'open',domains:[]});
});

test('REGISTRATION_MODE closes registration or leaves it to Google within school domains, never existing logins',async t=>{
 const {sqlite,env}=environment(t);
 assert.equal((await post(env,'/api/auth/register',account('lan@truong.edu.vn'))).status,201);
 const closed={...env,REGISTRATION_MODE:'closed'},refusal=await post(closed,'/api/auth/register',{});
 assert.equal(refusal.status,403);assert.deepEqual(await refusal.json(),{error:'Hoa Trí hiện chưa mở đăng ký tài khoản mới. Hãy liên hệ quản trị viên.',code:'registration_closed'});
 assert.equal((await post(closed,'/api/auth/login',{email:'lan@truong.edu.vn',password:'mat-khau-dai'})).status,200,'existing accounts still log in');
 const school={...env,REGISTRATION_MODE:'domain',ALLOWED_EMAIL_DOMAINS:'truong.edu.vn, @thpt-a.edu.vn'};
 assert.deepEqual(registrationPolicy(school),{mode:'domain',domains:['truong.edu.vn','thpt-a.edu.vn']});
 // Anyone can type the principal's address: a typed address proves nothing, so in domain mode only Google (which has
 // verified the mailbox) creates accounts, inside the school's domains or out of them.
 for(const email of ['hieutruong@truong.edu.vn','an@hs.truong.edu.vn','x@gmail.com']){
  const response=await post(school,'/api/auth/register',account(email));assert.equal(response.status,403,email);
  assert.deepEqual(await response.json(),{error:'Tài khoản mới chỉ được tạo bằng Google, với email thuộc truong.edu.vn hoặc thpt-a.edu.vn, nhưng đăng nhập Google chưa được cấu hình. Hãy liên hệ quản trị viên.',code:'registration_google_only'},email);
 }
 const withGoogle=await post({...school,GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'},'/api/auth/register',account('minh@truong.edu.vn'));
 assert.deepEqual(await withGoogle.json(),{error:'Tài khoản mới chỉ được tạo bằng nút “Tiếp tục bằng Google”, với email thuộc truong.edu.vn hoặc thpt-a.edu.vn.',code:'registration_google_only'});
 assert.equal((await post(school,'/api/auth/login',{email:'lan@truong.edu.vn',password:'mat-khau-dai'})).status,200,'existing accounts still log in');
 // The addresses Google may create accounts for: the allowed domains and their subdomains.
 for(const email of ['minh@truong.edu.vn','an@hs.truong.edu.vn','binh@THPT-A.edu.vn'])assert.equal(registrationRefusal(school,email),null,email);
 for(const email of ['x@gmail.com','x@truong.edu.vn.evil.example','x@nottruong.edu.vn',null])assert.equal(registrationRefusal(school,email),'Chỉ email thuộc truong.edu.vn hoặc thpt-a.edu.vn được tạo tài khoản.',String(email));
 // A domain mode without domains, or a mistyped mode, closes registration instead of opening it.
 assert.deepEqual(registrationPolicy({REGISTRATION_MODE:'domain'}),{mode:'closed',domains:[]});assert.deepEqual(registrationPolicy({REGISTRATION_MODE:'opne'}),{mode:'closed',domains:[]});
 assert.deepEqual(registrationPolicy({}),{mode:'open',domains:[]});assert.deepEqual((await me(school)).registration,{mode:'domain',domains:['truong.edu.vn','thpt-a.edu.vn']});
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM reader_users').get().count,1);
});

test('In domain mode Google creates accounts only for verified school addresses, and with REQUIRE_GOOGLE_WORKSPACE only for accounts the school manages',async t=>{
 const {sqlite,env}=environment(t,{GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',REGISTRATION_MODE:'domain',ALLOWED_EMAIL_DOMAINS:'truong.edu.vn'});
 const state=new URL((await worker.fetch(new Request(origin+'/api/auth/google/start?accept_terms=1'),env,{})).headers.get('Location')).searchParams.get('state');
 let profile;t.mock.method(globalThis,'fetch',async url=>String(url).startsWith('https://oauth2.googleapis.com/token')?Response.json({access_token:'test-access'}):Response.json(profile));
 // A sign-in that cannot finish goes back to the account page with a code the page explains (#account?loi=<code>).
 const callback=async(p,vars={})=>{profile=p;const response=await worker.fetch(new Request(`${origin}/api/auth/google/callback?state=${state}&code=test-code`,{headers:{Cookie:`cat_hien_oauth_state=${state}`}}),{...env,...vars},{});return [response.status,/#account\?loi=([a-z_]+)$/u.exec(response.headers.get('Location'))?.[1]||null];};
 const users=()=>sqlite.prepare('SELECT COUNT(*) AS count FROM reader_users').get().count;
 assert.deepEqual(await callback({sub:'g-1',email:'hieutruong@truong.edu.vn',email_verified:false}),[302,'google_unverified']);
 assert.deepEqual(await callback({sub:'g-2',email:'x@truong.edu.vn.evil.example',email_verified:true}),[302,'registration_domain']);
 // Checked whole: cut to 320 characters, this address would end in the school's domain.
 assert.deepEqual(await callback({sub:'g-3',email:`x@${'a'.repeat(304)}.truong.edu.vn.evil.example`,email_verified:true}),[302,'google_email_invalid']);
 assert.equal(users(),0);
 // REQUIRE_GOOGLE_WORKSPACE: a personal Google account made with a school address is not enough; hd names the school.
 const workspace={REQUIRE_GOOGLE_WORKSPACE:'1'},refused='registration_workspace';
 assert.deepEqual(await callback({sub:'g-4',email:'an@truong.edu.vn',email_verified:true},workspace),[302,refused]);
 assert.deepEqual(await callback({sub:'g-4',email:'an@truong.edu.vn',email_verified:true,hd:'truong.edu.vn.evil.example'},workspace),[302,refused]);
 assert.deepEqual(await callback({sub:'g-4',email:'an@truong.edu.vn',email_verified:true,hd:'truong.edu.vn'},workspace),[302,null]);
 assert.deepEqual(await callback({sub:'g-5',email:'binh@hs.truong.edu.vn',email_verified:true}),[302,null],'without the option a verified school address is enough');
 assert.deepEqual(sqlite.prepare('SELECT email FROM reader_users ORDER BY email').all().map(row=>row.email),['an@truong.edu.vn','binh@hs.truong.edu.vn']);
});

test('The daily registration cap counts an IPv6 network by its /64 and an IPv4 client by its address',async t=>{
 const {env}=environment(t,{DAILY_REGISTRATIONS_PER_IP:'3'});
 const register=async(i,ip)=>(await post(env,'/api/auth/register',account(`hs${i}@example.test`),{'CF-Connecting-IP':ip})).status,statuses=async(from,ips)=>{const list=[];for(const [i,ip] of ips.entries())list.push(await register(from+i,ip));return list;};
 assert.deepEqual(await statuses(0,['2001:db8:1:2::1','2001:db8:1:2::2','2001:db8:1:2:abcd::9','2001:0db8:0001:0002::ff']),[201,201,201,429],'every address of one /64 is one network');
 assert.deepEqual(await statuses(10,['2001:db8:1:3::1','203.0.113.9','203.0.113.9','203.0.113.9','203.0.113.9','203.0.113.10']),[201,201,201,201,429,201]);
});

test('Google sign-in needs the terms ticked, creates new accounts only where registration allows, and records consent',async t=>{
 const {sqlite,env}=environment(t,{GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'});
 const start=query=>worker.fetch(new Request(origin+'/api/auth/google/start'+query),env,{});
 const unticked=await start('');assert.equal(unticked.status,302);assert.equal(unticked.headers.get('Location'),origin+'/#account?loi=terms_required');
 const started=await start('?accept_terms=1&return_to=%2Fstudy.html');assert.equal(started.status,302);
 const state=new URL(started.headers.get('Location')).searchParams.get('state');
 // Google is played by a test double: no request leaves the machine.
 let profile;t.mock.method(globalThis,'fetch',async url=>String(url).startsWith('https://oauth2.googleapis.com/token')?Response.json({access_token:'test-access'}):Response.json(profile));
 const callback=vars=>worker.fetch(new Request(`${origin}/api/auth/google/callback?state=${state}&code=test-code`,{headers:{Cookie:`cat_hien_oauth_state=${state}; cat_hien_oauth_return=%2Fstudy.html`}}),{...env,...vars},{});
 profile={sub:'google-1',email:'Minh@Gmail.com',email_verified:true,name:'Minh',picture:''};
 // Refusals go back to the account page with their code, and with where the student was going (sau=xuong-dich).
 const closed=await callback({REGISTRATION_MODE:'closed'});assert.equal(closed.status,302);assert.equal(closed.headers.get('Location'),origin+'/#account?loi=registration_closed&sau=xuong-dich');assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM reader_users').get().count,0);
 const outside=await callback({REGISTRATION_MODE:'domain',ALLOWED_EMAIL_DOMAINS:'truong.edu.vn'});assert.equal(outside.headers.get('Location'),origin+'/#account?loi=registration_domain&sau=xuong-dich');
 const created=await callback({});assert.equal(created.status,302);assert.equal(created.headers.get('Location'),origin+'/study.html');
 const user=sqlite.prepare('SELECT id,terms_version,terms_accepted_at FROM reader_users WHERE google_sub=?').get('google-1');assert.equal(user.terms_version,TERMS_VERSION);assert.ok(user.terms_accepted_at);
 assert.equal((await me(env,sessionCookie(created))).user.provider,'google');
 // A returning user signs in even when registration has closed since; an account from before consent was recorded gets it now.
 sqlite.prepare('UPDATE reader_users SET terms_version=NULL,terms_accepted_at=NULL WHERE id=?').run(user.id);
 assert.equal((await callback({REGISTRATION_MODE:'closed'})).status,302);assert.equal(sqlite.prepare('SELECT terms_version FROM reader_users WHERE id=?').get(user.id).terms_version,TERMS_VERSION);
 sqlite.prepare('UPDATE reader_users SET disabled_at=CURRENT_TIMESTAMP WHERE id=?').run(user.id);
 const locked=await callback({});assert.equal(locked.status,302);assert.equal(locked.headers.get('Location'),origin+'/#account?loi=account_disabled&sau=xuong-dich');
 assert.equal(locked.headers.getSetCookie().some(line=>line.startsWith('cat_hien_session=')),false,'a locked account gets no session');
});

test('A locked account cannot log in or use its sessions until an admin unlocks it',async t=>{
 const {sqlite,env}=environment(t);
 const created=await post(env,'/api/auth/register',account('lan@example.test')),cookie=sessionCookie(created),uid=sqlite.prepare('SELECT id FROM reader_users').get().id;
 const admin=(body,id=uid)=>worker.fetch(new Request(`${origin}/api/users/${id}`,{method:'PATCH',headers:{Authorization:`Bearer ${ADMIN}`,'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)}),env,{});
 assert.equal((await admin({disabled:'yes'})).status,400);assert.equal((await admin({disabled:true},'missing-user')).status,404);
 assert.deepEqual(await (await admin({disabled:true})).json(),{ok:true,disabled:true});
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM reader_sessions').get().count,0,'locking ends the open sessions');
 assert.equal((await me(env,cookie)).authenticated,false);
 assert.equal((await post(env,'/api/auth/login',{email:'lan@example.test',password:'sai-mat-khau'})).status,401,'a wrong password says nothing about the lock');
 const locked=await post(env,'/api/auth/login',{email:'lan@example.test',password:'mat-khau-dai'});assert.equal(locked.status,403);assert.equal((await locked.json()).code,'account_disabled');assert.equal(locked.headers.getSetCookie().length,0);
 // A session that somehow survived (created before the lock) is refused too.
 const {hashToken}=await import('./reader-auth.js');sqlite.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await hashToken('old-session'),uid,Date.now()+60000);
 assert.equal((await me(env,'cat_hien_session=old-session')).authenticated,false);
 const users=await (await worker.fetch(new Request(origin+'/api/users',{headers:{Authorization:`Bearer ${ADMIN}`}}),env,{})).json();assert.ok(users[0].disabled_at);assert.equal(users[0].terms_version,TERMS_VERSION);
 assert.deepEqual(await (await admin({disabled:false})).json(),{ok:true,disabled:false});
 assert.equal((await post(env,'/api/auth/login',{email:'lan@example.test',password:'mat-khau-dai'})).status,200);
});
