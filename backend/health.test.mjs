import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import worker from './worker.js';
import {MIGRATIONS} from './health.js';

const secrets={ADMIN_TOKEN:'a1'.repeat(32),PDF_LAYOUT_SERVICE_URL:'https://pdf.private-host.example',PDF_LAYOUT_SERVICE_TOKEN:'pdf-service-token-never-shown',GEMINI_API_KEY:'gemini-key-never-shown-000000',GOOGLE_CLIENT_SECRET:'google-secret-never-shown'};
// all: the names `wrangler d1 migrations apply` recorded (every migration unless a test says otherwise).
const database=(first,all=async()=>({results:MIGRATIONS.map(name=>({name}))}))=>({prepare(sql){return {bind(){return this;},async first(){return first(sql);},all};}});
const health=(env,init)=>worker.fetch(new Request('https://hoa-tri.example/api/health',init),env,{});

test('Health reports the database, the deployed version and the PDF service state, never a secret',async()=>{
 const meta={id:'5b1c9a2e-0000-4000-8000-000000000001',tag:'6ebfabc',timestamp:'2026-10-17T01:02:03Z'},response=await health({...secrets,DB:database(sql=>sql.startsWith('SELECT 1')?{ok:1}:null),CF_VERSION_METADATA:meta});
 assert.equal(response.status,200);const body=await response.json();
 assert.deepEqual({...body,time:'t'},{ok:true,service:'hoa-tri',version:'6ebfabc',deployedAt:'2026-10-17T01:02:03Z',database:'ok',pdfLayout:'configured',time:'t'});
 assert.ok(!Number.isNaN(Date.parse(body.time)));
 const text=JSON.stringify(body);for(const value of Object.values(secrets))assert.ok(!text.includes(value),'health must not show configuration values');
 assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
 // Without version metadata (wrangler dev) the version says so instead of guessing.
 const local=await (await health({DB:database(()=>({ok:1}))})).json();assert.equal(local.version,'dev');assert.equal(local.deployedAt,null);assert.equal(local.pdfLayout,'off');
 const versionOnly=await (await health({DB:database(()=>({ok:1})),CF_VERSION_METADATA:{id:meta.id}})).json();assert.equal(versionOnly.version,meta.id);
});

test('Health answers 503 when the database fails, logs it for the operator, and HEAD carries no body',async t=>{
 const logs=[];t.mock.method(console,'error',line=>logs.push(line));
 const failing={...secrets,DB:{prepare(){return {bind(){return this;},async first(){throw new Error('D1_ERROR: network connection lost');}};}}};
 const response=await health(failing);assert.equal(response.status,503);
 const body=await response.json();assert.equal(body.ok,false);assert.equal(body.database,'error');assert.doesNotMatch(JSON.stringify(body),/D1_ERROR|network/);
 assert.equal(logs.length,1);assert.equal(JSON.parse(logs[0]).event,'health_db_error');
 const head=await health(failing,{method:'HEAD'});assert.equal(head.status,503);assert.equal(await head.text(),'');
 const up=await health({DB:database(()=>({ok:1}))},{method:'HEAD'});assert.equal(up.status,200);assert.equal(await up.text(),'');
 assert.equal((await health({})).status,503,'a missing database binding is unhealthy, not a crash');
});

// The deep check calls the PDF service's own /health; each case uses its own service URL (the Worker keeps an answer 30 s).
const serviceHealth=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const liveService={ok:true,engine:'pymupdf-puppeteer',busy:true,active:1,jobs:2,version:{layout:'0123456789abcdef',service:'fedcba9876543210'},font:'LiberationSerif-Regular.ttf'};
function deep(t,answer,vars={}){
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url:String(url),auth:options.headers.Authorization});return answer();});
 const env={...secrets,PDF_LAYOUT_SERVICE_URL:`https://pdf-${Math.random().toString(16).slice(2)}.private-host.example`,DB:database(()=>({ok:1})),...vars};
 return {calls,env,get:init=>health(env,init),deepGet:init=>worker.fetch(new Request('https://hoa-tri.example/api/health?deep=1',init),env,{})};
}

test('Health ?deep=1 asks the PDF service through the Worker and compares its layout checks with the Worker\'s own',async t=>{
 const ok=deep(t,()=>serviceHealth(liveService),{PDF_LAYOUT_VERSION:'0123456789abcdef'}),response=await ok.deepGet(),body=await response.json();
 assert.equal(response.status,200);assert.equal(body.ok,true);
 assert.deepEqual(body.pdfService,{status:'ok',ms:body.pdfService.ms,busy:true,active:1,jobs:2,version:liveService.version,expectedLayout:'0123456789abcdef',layoutMatch:true,font:'LiberationSerif-Regular.ttf'});
 assert.equal(ok.calls.length,1);assert.equal(ok.calls[0].url,`${ok.env.PDF_LAYOUT_SERVICE_URL}/health`);assert.equal(ok.calls[0].auth,`Bearer ${secrets.PDF_LAYOUT_SERVICE_TOKEN}`);
 const text=JSON.stringify(body);for(const value of [...Object.values(secrets),ok.env.PDF_LAYOUT_SERVICE_URL,'private-host'])assert.ok(!text.includes(value),'no secret or address in the answer');
 // Polling is cheap for the service: the answer is kept 30 s, and the plain check never calls the service.
 await ok.deepGet();await ok.get();assert.equal(ok.calls.length,1);assert.equal((await (await ok.get()).json()).pdfService,undefined);
 // A service running other layout checks than this Worker: scanned pages may be refused, so the check fails.
 const mismatch=deep(t,()=>serviceHealth(liveService),{PDF_LAYOUT_VERSION:'aaaaaaaaaaaaaaaa'}),stale=await mismatch.deepGet();
 assert.equal(stale.status,503);const staleBody=await stale.json();assert.equal(staleBody.ok,false);assert.equal(staleBody.database,'ok');
 assert.deepEqual([staleBody.pdfService.status,staleBody.pdfService.layoutMatch],['mismatch',false]);
 // A Worker deployed without the hash (plain wrangler deploy, wrangler dev) cannot compare: that is not a failure.
 const unknown=await (await deep(t,()=>serviceHealth(liveService)).deepGet()).json();assert.equal(unknown.pdfService.status,'ok');assert.equal(unknown.pdfService.layoutMatch,null);
});

test('Health ?deep=1 answers 503 when the PDF service refuses the token, fails or is out of reach; HEAD carries only the status',async t=>{
 const logs=[];t.mock.method(console,'error',line=>logs.push(JSON.parse(line).event));
 for(const [answer,status] of [[()=>serviceHealth({error:'Unauthorized'},401),'unauthorized'],[()=>serviceHealth({error:'x'},500),'error'],[()=>new Response('<html>502</html>',{status:502}),'error'],[()=>{throw new TypeError('fetch failed');},'unreachable'],[()=>{throw new DOMException('timed out','TimeoutError');},'timeout']]){
  const check=deep(t,answer),response=await check.deepGet(),body=await response.json();
  assert.equal(response.status,503,status);assert.equal(body.ok,false);assert.equal(body.pdfService.status,status);assert.doesNotMatch(JSON.stringify(body),/fetch failed|timed out|private-host/u);
  const head=await check.deepGet({method:'HEAD'});assert.equal(head.status,503);assert.equal(await head.text(),'');
 }
 assert.deepEqual(logs,['health_pdf_error','health_pdf_error'],'the operator finds a connection failure in Workers Logs');
 // Without a PDF service the deep check has nothing to ask and stays healthy.
 const off=await worker.fetch(new Request('https://hoa-tri.example/api/health?deep=1'),{DB:database(()=>({ok:1}))},{});
 assert.equal(off.status,200);assert.deepEqual((await off.json()).pdfService,{status:'off'});
});

test('MIGRATIONS is database/migrations: a new migration is added to backend/health.js too',()=>{
 const files=readdirSync(new URL('../database/migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort();
 assert.deepEqual([...MIGRATIONS],files,'add the new file name to MIGRATIONS in backend/health.js');
});

test('Health ?deep=1 names the migrations the database lacks and answers 503 until they are applied',async t=>{
 const {sqliteEnvironment}=await import('./test-support/sqlite-d1.mjs'),{sqlite,env}=sqliteEnvironment(t,{before:'0025'});
 // What `wrangler d1 migrations apply` records beside the tables (sqliteEnvironment runs the files without it).
 sqlite.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
 const record=names=>{for(const name of names)sqlite.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);},later=MIGRATIONS.filter(name=>name>='0025');
 record(MIGRATIONS.filter(name=>name<'0025'));
 const deepGet=(init={})=>worker.fetch(new Request('http://127.0.0.1:8787/api/health?deep=1',init),env,{});
 const behind=await deepGet(),body=await behind.json();
 assert.equal(behind.status,503);assert.equal(body.ok,false);assert.equal(body.database,'ok');assert.deepEqual(body.pdfService,{status:'off'});
 assert.deepEqual(body.migrations,{status:'pending',pending:later});assert.ok(later.includes('0025_admin_accounts.sql')&&later.includes('0026_study_engine.sql'));
 assert.equal((await deepGet({method:'HEAD'})).status,503);
 // The plain check stays what uptime checks and start.cmd ask: is the database reachable.
 const plain=await worker.fetch(new Request('http://127.0.0.1:8787/api/health'),env,{});assert.equal(plain.status,200);assert.equal((await plain.json()).migrations,undefined);
 record(later);const current=await deepGet();assert.equal(current.status,200);assert.deepEqual((await current.json()).migrations,{status:'ok'});
 // A database never migrated has no table of names: everything is pending.
 sqlite.exec('DROP TABLE d1_migrations');assert.deepEqual((await (await deepGet()).json()).migrations,{status:'pending',pending:[...MIGRATIONS]});
 // A table that cannot be read fails the deep check without its error text; the operator finds it in the log.
 const logs=[];t.mock.method(console,'error',line=>logs.push(JSON.parse(line).event));
 const failing=await worker.fetch(new Request('https://hoa-tri.example/api/health?deep=1'),{DB:database(()=>({ok:1}),async()=>{throw new Error('D1_ERROR: storage reset: SQLITE_IOERR');})},{});
 assert.equal(failing.status,503);const failed=await failing.json();assert.deepEqual(failed.migrations,{status:'error'});assert.doesNotMatch(JSON.stringify(failed),/D1_ERROR|SQLITE/u);
 assert.deepEqual(logs,['health_migrations_error']);
});

test('Health needs no login or Origin and only answers GET and HEAD',async()=>{
 const env={DB:database(()=>({ok:1}))};
 assert.equal((await health(env,{headers:{Origin:'https://elsewhere.example'}})).status,200);
 const post=await health(env,{method:'POST',headers:{Origin:'https://hoa-tri.example'},body:'{}'});assert.equal(post.status,405);assert.equal(post.headers.get('Allow'),'GET, HEAD');
});
