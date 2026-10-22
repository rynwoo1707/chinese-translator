import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import worker from './worker.js';
import {studyRoute} from './study-translation.js';
import {overDailyCap,vietnamDay,secondsToReset,dailyMax,limited,rateLimit,tooMany,TOO_FAST} from './rate-limit.js';
import {addressKey,clientIp} from './http.js';

const origin='https://hoa-tri.example',reader={id:'reader-1',email:'lan@example.test',name:'Lan',picture:''};
class D1Statement{
 constructor(database,sql){this.statement=database.prepare(sql);this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){return this.statement.get(...this.args)||null;}
 async all(){return {results:this.statement.all(...this.args),success:true};}
 execute(){const result=this.statement.run(...this.args);return {success:true,meta:{changes:result.changes}};}
 async run(){return this.execute();}
}
function sqliteDatabase(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
 for(const name of readdirSync(fileURLToPath(new URL('../database/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../database/migrations/'+name,import.meta.url),'utf8'));
 return {sqlite,DB:{prepare:sql=>new D1Statement(sqlite,sql),async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}}};
}
// A rate-limit binding that refuses keys in `blocked` and records every key it was asked about.
function limiter(blocked=[]){const keys=[];return {keys,async limit({key}){keys.push(key);return {success:!blocked.some(prefix=>key.startsWith(prefix))};}};}
const signedIn={prepare(sql){return {bind(){return this;},async first(){return sql.includes('reader_sessions')?reader:null;},async all(){return {results:[]};},async run(){return {meta:{changes:1}};}};}};

test('A refused rate-limit binding answers 429 with Retry-After before the password is hashed',async t=>{
 const AUTH_LIMITER=limiter(['login:']),API_LIMITER=limiter();let queried=false;
 const env={AUTH_LIMITER,API_LIMITER,DB:{prepare(){queried=true;throw new Error('The password must not be checked');}}};
 const response=await worker.fetch(new Request(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'CF-Connecting-IP':'203.0.113.9'},body:JSON.stringify({email:' Lan@Example.test ',password:'mat-khau-dai'})}),env,{});
 assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'60');
 assert.deepEqual(await response.json(),{error:'Bạn thao tác quá nhanh. Hãy đợi khoảng một phút rồi thử lại.',code:'rate_limited',retryAfter:60});
 // The strict count is per email and network; the loose per-email one is not reached once the strict one refuses.
 assert.equal(queried,false);assert.deepEqual(API_LIMITER.keys,['login-ip:203.0.113.9']);assert.deepEqual(AUTH_LIMITER.keys,['login:lan@example.test|203.0.113.9']);
});

// The Workers binding as it counts: at most `max` uses per key (one minute, one location).
function countingLimiter(max){const counts=new Map();return {counts,async limit({key}){const count=(counts.get(key)||0)+1;counts.set(key,count);return {success:count<=max};}};}
test('Wrong passwords sent on purpose do not lock a student out of her account; guesses from many networks still stop',async t=>{
 // The loose limiter allows 30 here instead of 120 a minute, so fewer passwords are hashed.
 const {DB}=sqliteDatabase(t),AUTH_LIMITER=countingLimiter(10),API_LIMITER=countingLimiter(30),env={DB,AUTH_LIMITER,API_LIMITER};
 const post=(path,body,ip)=>worker.fetch(new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'CF-Connecting-IP':ip},body:JSON.stringify(body)}),env,{});
 assert.equal((await post('/api/auth/register',{name:'Lan',email:'lan@example.test',password:'mat-khau-cua-lan',acceptTerms:true},'198.51.100.1')).status,201);
 const guesses=[];for(let i=0;i<12;i++)guesses.push((await post('/api/auth/login',{email:'lan@example.test',password:`doan-sai-${i}`},'203.0.113.66')).status);
 assert.deepEqual(guesses,[...Array(10).fill(401),429,429],'the guessing network is stopped after 10 tries a minute');
 assert.equal((await post('/api/auth/login',{email:'lan@example.test',password:'mat-khau-cua-lan'},'198.51.100.1')).status,200,'Lan still signs in from her own network');
 // Another address of the same IPv6 /64 is the same network.
 assert.equal((await post('/api/auth/login',{email:'lan@example.test',password:'doan-sai'},'2001:db8:7:7::1')).status,401);
 for(let i=0;i<9;i++)await post('/api/auth/login',{email:'lan@example.test',password:'doan-sai'},`2001:db8:7:7::${(i+2).toString(16)}`);
 assert.equal((await post('/api/auth/login',{email:'lan@example.test',password:'doan-sai'},'2001:db8:7:7:ffff::1')).status,429);
 // Spread over many networks, guesses still meet the looser count per email.
 const spread=[];for(let i=0;i<10;i++)spread.push((await post('/api/auth/login',{email:'lan@example.test',password:'doan-sai'},'192.0.2.1')).status);
 assert.deepEqual(spread,[...Array(9).fill(401),429]);assert.equal(API_LIMITER.counts.get('login-email:lan@example.test'),31);
 assert.equal((await post('/api/auth/login',{email:'lan@example.test',password:'doan-sai'},'192.0.2.200')).status,429);
});

test('A limit can bring its own message and say whose it is (scope); without them the answer is as before',async t=>{
 const {DB}=sqliteDatabase(t),env={DB,AUTH_LIMITER:limiter(['k'])},network='Mạng này vừa dùng hết lượt trong một phút.';
 assert.deepEqual(await (await rateLimit(env,[{binding:'AUTH_LIMITER',key:'k1'}])).json(),{error:TOO_FAST,code:'rate_limited',retryAfter:60});
 const own=await rateLimit(env,[{binding:'AUTH_LIMITER',key:'k2',message:network,scope:'network'}]);
 assert.equal(own.status,429);assert.equal(own.headers.get('Retry-After'),'60');assert.deepEqual(await own.json(),{error:network,code:'rate_limited',retryAfter:60,scope:'network'});
 const daily=()=>rateLimit(env,[{daily:'register:x',max:1,message:'Mạng này đã tạo đủ tài khoản hôm nay.',scope:'network'}]);
 assert.equal(await daily(),null);const refused=await daily(),body=await refused.json();
 assert.equal(body.error,'Mạng này đã tạo đủ tài khoản hôm nay.');assert.equal(body.scope,'network');assert.equal(Number(refused.headers.get('Retry-After')),body.retryAfter);
 const upload=()=>rateLimit(env,[{daily:'upload:x',max:1,label:'tải lên'}]);assert.equal(await upload(),null);
 assert.deepEqual(Object.keys(await (await upload()).json()).sort(),['code','error','retryAfter'],'no scope unless a check names one');
 assert.deepEqual(await tooMany(30,'Đợi đã.',{scope:'failures'}).json(),{error:'Đợi đã.',code:'rate_limited',retryAfter:30,scope:'failures'});
});

test('Limits count an IPv6 client by its /64 network and an IPv4 client by its address',()=>{
 for(const spelling of ['2001:db8:1:2::1','2001:DB8:0001:0002:abcd::','2001:db8:1:2:ffff:ffff:ffff:ffff','[2001:db8:1:2::9]'])assert.equal(addressKey(spelling),'2001:db8:1:2::/64',spelling);
 assert.equal(addressKey('2001:db8:1:3::1'),'2001:db8:1:3::/64');assert.equal(addressKey('203.0.113.9'),'203.0.113.9');
 assert.equal(addressKey('::ffff:203.0.113.9'),'203.0.113.9','an IPv4 client written as IPv6 is that IPv4 address');assert.equal(addressKey('::1'),'0:0:0:0::/64');
 for(const odd of ['1::2:3:4:5:6:7:8','gibberish:zz','2001:db8::1.2.3.256'])assert.equal(addressKey(odd),odd,'what is not an address is counted as it is');
 assert.equal(clientIp(new Request(origin,{headers:{'CF-Connecting-IP':'2001:db8:1:2::7'}})),'2001:db8:1:2::/64');assert.equal(clientIp(new Request(origin)),'local');
});

test('Study routes are limited per account: uploads and PDF service calls on the heavy limiter, other changes on the API one',async()=>{
 const call=async(env,path,method='POST',body='{}')=>{const url=new URL(origin+path);return studyRoute(new Request(url,{method,headers:{Cookie:'cat_hien_session=token',Origin:origin,'Content-Type':'application/json'},...(method==='GET'?{}:{body})}),env,url,path);};
 const HEAVY_LIMITER=limiter(['pdf:','upload:']),API_LIMITER=limiter(['api:']),env={HEAVY_LIMITER,API_LIMITER,DB:signedIn,FILES:{async get(){return null;},async put(){}}};
 for(const path of ['/api/my/study/pdf-layout/extract','/api/my/study/pdf-layout/refresh','/api/my/study/pdf-layout/render','/api/my/study/extract'])assert.equal((await call(env,path)).status,429,path);
 for(const [path,method] of [['/api/my/study/translate','POST'],['/api/my/study/translate-blocks','POST'],['/api/my/study/ocr','POST'],['/api/my/study/models','POST'],['/api/my/study/pdf-layout/ocr-blocks','POST'],['/api/my/study/history','POST'],['/api/my/study/history/x','PUT'],['/api/my/study/history/x','DELETE'],['/api/my/study/pdf-layout/font','GET']])assert.equal((await call(env,path,method)).status,429,`${method} ${path}`);
 assert.deepEqual([...new Set(HEAVY_LIMITER.keys)],['pdf:reader-1','upload:reader-1']);assert.deepEqual([...new Set(API_LIMITER.keys)],['api:reader-1']);
 // Reading history, books and settings is never limited.
 for(const path of ['/api/my/study/history','/api/my/study/config','/api/my/study/books'])assert.notEqual((await call(env,path,'GET')).status,429,path);
});

test('Limits fail open: no binding, a binding error or no database never blocks a student',async t=>{
 const lines=[];t.mock.method(console,'error',line=>lines.push(line));
 assert.equal(await limited({},'AUTH_LIMITER','k'),false);
 assert.equal(await limited({AUTH_LIMITER:{async limit(){throw new Error('binding unavailable');}}},'AUTH_LIMITER','k'),false);
 assert.equal(JSON.parse(lines[0]).event,'rate_limit_error');assert.doesNotMatch(lines[0],/"k"/u);
 assert.equal(await overDailyCap({},'k',1),false);assert.equal(await overDailyCap({DB:{prepare(){throw new Error('D1 down');}}},'k',1),false);
 assert.equal(await overDailyCap({DB:signedIn},'k',1),false,'a test double answering any row counts as unused');
});

test('Daily caps count in D1 by Vietnam day and reset on the next day',async t=>{
 const {sqlite,DB}=sqliteDatabase(t),env={DB},evening=Date.parse('2026-10-17T16:59:00Z'),midnight=Date.parse('2026-10-17T17:00:00Z');
 assert.equal(vietnamDay(evening)+1,vietnamDay(midnight),'a new day starts at 00:00 in Vietnam (17:00 UTC)');assert.equal(secondsToReset(evening),60);
 assert.deepEqual([await overDailyCap(env,'upload:a',2,evening),await overDailyCap(env,'upload:a',2,evening),await overDailyCap(env,'upload:a',2,evening)],[false,false,true]);
 assert.equal(await overDailyCap(env,'upload:b',2,evening),false,'each key has its own count');
 assert.equal(await overDailyCap(env,'upload:a',2,midnight),false);assert.deepEqual({...sqlite.prepare("SELECT window_start,count FROM rate_limits WHERE key='upload:a'").get()},{window_start:vietnamDay(midnight),count:1});
 // The new day's first use clears finished days, so a registration key's IP address is not kept past the day.
 assert.deepEqual(sqlite.prepare('SELECT key FROM rate_limits').all().map(row=>row.key),['upload:a']);
 assert.deepEqual([dailyMax({X:'0'},'X',5),dailyMax({X:' 12 '},'X',5),dailyMax({X:'nhiều'},'X',5),dailyMax({},'X',5)],[0,12,5,5]);
 assert.equal(await overDailyCap(env,'upload:a',0,midnight),false,'0 turns a cap off');
});

test('Translation requests have a daily cap per account, counted only for valid requests',async t=>{
 const {sqlite,DB}=sqliteDatabase(t),stored=[];
 sqlite.prepare('INSERT INTO reader_users(id,google_sub,email,name) VALUES(?,?,?,?)').run(reader.id,'sub-1',reader.email,reader.name);
 const {hashToken}=await import('./reader-auth.js');sqlite.prepare('INSERT INTO reader_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await hashToken('token'),reader.id,Date.now()+3600000);
 const env={DB,DAILY_REQUESTS_PER_USER:'2',FILES:{async put(key){stored.push(key);},async delete(){}}};
 const send=link=>{const form=new FormData();form.set('title','Sách cần dịch');form.set('source_url',link);return worker.fetch(new Request(origin+'/api/requests',{method:'POST',headers:{Cookie:'cat_hien_session=token',Origin:origin},body:form}),env,{});};
 assert.equal((await send('ftp://not-a-web-link')).status,400,'an invalid request is not counted');
 assert.equal((await send('https://example.test/1')).status,201);assert.equal((await send('https://example.test/2')).status,201);
 const refused=await send('https://example.test/3');assert.equal(refused.status,429);
 const body=await refused.json();assert.equal(body.error,'Bạn đã dùng hết 2 lượt gửi yêu cầu dịch hôm nay. Hạn mức được đặt lại lúc 0:00 (giờ Việt Nam).');
 assert.equal(Number(refused.headers.get('Retry-After')),body.retryAfter);assert.ok(body.retryAfter>0&&body.retryAfter<=86400);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM requests').get().count,2);
});
